## Context
<!-- Why is this change needed? What problem does it solve? -->
<!-- Link related issues or incidents -->
- Related issue:
- Background / motivation:
- Constraints / assumptions:

---

## Content / Changes
<!-- What exactly changed in this PR -->
- 
- 
- 

<!-- Optional: call out non-obvious changes -->
- Refactors:
- New features:
- Removed / deprecated behavior:

---

## Test Plan
<!-- How was this change validated -->

### Test Details
<!-- Commands, configs, or steps used to test -->
- 

### Test Output / Feature Demonstration
<!-- Paste test output, logs, screenshots, benchmarks, or example requests/responses -->
- 

---

## Web clipper checklist
<!-- Delete a line only when it genuinely cannot apply. "N/A — why" is a valid answer. -->

- **Browsers**: which did you load the unpacked extension in? (Chrome is the target; Chrome 149
  removed `--load-extension`, so headless verification means injecting `content.js` plus a mock
  `chrome` over CDP — say which route you used.)
- **Manifest / permissions**: any change to `manifest.json`, its `permissions`, or `host_permissions`?
  A new permission re-prompts every existing user on update — call it out.
- **Page compatibility**: the content script runs inside arbitrary sites. What did you test it on,
  and what happens on a page that does not match your assumptions?
- **Message contract with the add-on**: does this change what is sent to Omnia? Both sides must
  survive a version skew — an older Omnia receiving this payload must not break.
- **User-visible change / migration**: what will an existing user notice after the update?
