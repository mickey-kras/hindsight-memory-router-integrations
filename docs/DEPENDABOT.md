# Dependabot

Patch/minor updates auto-merge after every dependency has a known compatibility score of at least 75% and all required checks pass. Majors and unknown scores stay manual. Node typings stay on Node 22.

For patch/minor npm updates, preparation regenerates dependency provenance, both packages and their hashes even when the score is unknown. Builds run with read-only permissions. A separate job commits only generated files, triggering fresh PR checks. Stale patch/minor PRs are recreated by Dependabot before preparation.

Setup: create an owner fine-grained PAT for this repository with **Contents: read/write**. Save it as the Actions secret `DEPENDABOT_UPDATE_TOKEN`. It is used only by the publish job; no workflow or administration permission is needed.

Merge the preparation PR, configure the secret, then run **dependabot auto-merge refresh** on `main`. Failed preparation runs can be rerun after fixing their reported cause. The 30-minute refresh handles subsequent updates.
