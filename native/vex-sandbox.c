/*
 * vex-sandbox: runs a command under a Landlock file-system ruleset.
 *
 *   vex-sandbox [-l PATH] [-r PATH] [-w PATH] ... -- PROGRAM [ARG...]
 *   vex-sandbox --probe
 *
 * -l lets the command list a directory tree, -r adds reading and executing,
 * -w adds creating, changing and removing. Every access right the running
 * kernel supports is handled, so anything not granted is denied. Missing or
 * unreachable paths are skipped. Landlock also stops the command from tracing
 * processes outside it and, from ABI 6, from signalling them.
 * --probe applies an empty ruleset to itself and prints the ABI version, so a
 * caller can learn whether the kernel will actually confine a command.
 *
 * Setup failures exit with 125 and a message on standard error; otherwise the
 * process becomes PROGRAM.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

/* Declared locally so the helper builds against older kernel headers. */
struct ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REFER (1ULL << 13)
#define FS_TRUNCATE (1ULL << 14)
#define FS_IOCTL_DEV (1ULL << 15)
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define SCOPE_SIGNAL (1ULL << 1)

#define LIST FS_READ_DIR
#define READ (FS_EXECUTE | FS_READ_FILE | FS_READ_DIR)
/* Bits 4..12 remove and make directory entries; ABI 1 handles all of 0..12. */
#define WRITE (READ | FS_WRITE_FILE | (((1ULL << 13) - 1) & ~((1ULL << 4) - 1)) | FS_REFER | FS_TRUNCATE | FS_IOCTL_DEV)
#define FILE_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)

static int fail(const char *what, const char *path) {
  if (path)
    fprintf(stderr, "vex-sandbox: %s %s: %s\n", what, path, strerror(errno));
  else
    fprintf(stderr, "vex-sandbox: %s: %s\n", what, strerror(errno));
  return 125;
}

static uint64_t handled_rights(int abi) {
  uint64_t rights = (1ULL << 13) - 1;
  if (abi >= 2) rights |= FS_REFER;
  if (abi >= 3) rights |= FS_TRUNCATE;
  if (abi >= 5) rights |= FS_IOCTL_DEV;
  return rights;
}

static int restrict_self(int ruleset) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("cannot set no_new_privs", NULL);
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) return fail("cannot apply the ruleset", NULL);
  return 0;
}

static int create_ruleset(int abi) {
  struct ruleset_attr attr = { .handled_access_fs = handled_rights(abi) };
  if (abi >= 6) attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL;
  return (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
}

static int add_path(int ruleset, const char *path, uint64_t rights, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  /* A path that cannot be reached grants nothing, which denies the same accesses a rule would have allowed. */
  if (fd < 0) return errno == ENOENT || errno == ENOTDIR || errno == ELOOP || errno == EACCES ? 0 : fail("cannot open", path);
  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    return fail("cannot inspect", path);
  }
  struct landlock_path_beneath_attr rule = { .allowed_access = rights & handled, .parent_fd = fd };
  if (!S_ISDIR(st.st_mode)) rule.allowed_access &= FILE_RIGHTS;
  int rc = (int)syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  close(fd);
  return rc == 0 ? 0 : fail("cannot add a rule for", path);
}

int main(int argc, char **argv) {
  int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) return fail("Landlock is unavailable", NULL);

  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    int ruleset = create_ruleset(abi);
    if (ruleset < 0) return fail("cannot create a ruleset", NULL);
    int rc = restrict_self(ruleset);
    if (rc == 0) printf("%d\n", abi);
    return rc;
  }

  int ruleset = create_ruleset(abi);
  if (ruleset < 0) return fail("cannot create a ruleset", NULL);
  uint64_t handled = handled_rights(abi);
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    uint64_t rights;
    if (strcmp(argv[i], "-l") == 0) rights = LIST;
    else if (strcmp(argv[i], "-r") == 0) rights = READ;
    else if (strcmp(argv[i], "-w") == 0) rights = WRITE;
    else {
      fprintf(stderr, "vex-sandbox: unknown option %s\n", argv[i]);
      return 125;
    }
    if (++i >= argc) {
      fprintf(stderr, "vex-sandbox: %s needs a path\n", argv[i - 1]);
      return 125;
    }
    int rc = add_path(ruleset, argv[i], rights, handled);
    if (rc != 0) return rc;
  }
  if (i >= argc) {
    fprintf(stderr, "vex-sandbox: no command after --\n");
    return 125;
  }
  int rc = restrict_self(ruleset);
  if (rc != 0) return rc;
  close(ruleset);
  execvp(argv[i], argv + i);
  return fail("cannot run", argv[i]);
}
