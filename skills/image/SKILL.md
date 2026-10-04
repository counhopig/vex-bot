---
name: image
description: "Understand a local image with the configured vision model: describe the picture or answer questions about it."
---

# Image understanding

Run `scripts/analyze.mjs`, which resolves the configured model through Vex's model registry. The model must declare image input support; no model is picked automatically and no protocol is guessed.

```bash
node "<this skill's directory>/scripts/analyze.mjs" "<image path>" "<question>"
```

Add `--config "<path to config.yaml>"` if needed. Inside Vex's bash tool the current configuration is used by default through `VEX_CONFIG_PATH`; run standalone, it reads `VEX_HOME/config.yaml`, or `~/.vex/config.yaml` when `VEX_HOME` is unset.

To use a different configured model, pass `--provider "<provider>" --model "<model id>"` together. The API key comes from the configuration or the provider's environment variable; when authenticating through an environment variable, allow that variable explicitly in `bashEnvPassthrough`. Never put a key in command arguments.

PNG, JPEG, WebP and GIF are supported, up to 10 MB. The script runs through bash and follows approval. Return the analysis to the owner; if the file, the model or the service fails, report the error as it is.
