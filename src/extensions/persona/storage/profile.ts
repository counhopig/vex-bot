import { UserProfile, ProfileFact } from "../models.js";
import type { UserData } from "../storage.js";

/** Get user profile from data */
export function profileGetProfile(data: UserData): UserProfile {
  const profileData = data.profile;
  if (profileData) {
    return UserProfile.fromDict(profileData);
  }
  return new UserProfile();
}

/** Merge updates into profile data in-place */
export function profileUpdateProfile(
  data: UserData,
  updates: Record<string, unknown>,
): void {
  const existing = data.profile ?? {};
  Object.assign(existing, updates);
  data.profile = existing;
}

/** Initialize or replace persona data */
export function profileSetupPersona(
  data: UserData,
  persona: Record<string, unknown>,
): void {
  data.profile = persona;
}

/** Add a fact to profile_facts, dedup by (category, content). Returns existing fact if duplicate. */
export function profileAddFact(
  data: UserData,
  factDict: Record<string, unknown>,
): ProfileFact | undefined {
  const facts = data.profile_facts ?? [];
  for (const existing of facts) {
    if (
      (existing.category as string | undefined) === factDict.category &&
      (existing.content as string | undefined) === factDict.content
    ) {
      return ProfileFact.fromDict(existing);
    }
  }
  facts.push(factDict);
  if (facts.length > 50) {
    data.profile_facts = facts.slice(-50);
  } else {
    data.profile_facts = facts;
  }
  return undefined;
}

/** Get all profile facts */
export function profileGetAllFacts(data: UserData): ProfileFact[] {
  const factsData = data.profile_facts ?? [];
  return factsData.map((f) => ProfileFact.fromDict(f));
}
