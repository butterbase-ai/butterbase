# Bundled AI command guidance: declared video references

This is the repository copy for the external Butterbase Skills AI skill/command. Sync it into that plugin before publishing the feature; the external skills repository is not present in this checkout.

When implementing video generation, preserve the returned job ID, show the reported stage, poll without issuing another submission, and display authenticated content URLs after completion. Use the caller's explicit fictional-character declaration only. Never silently add declarations or automatically label real people as fictional.

### Optional fictional character references

Eligible apps and models can declare specific image slots as AI-generated fictional characters:

```json
{
  "input_images": ["https://images.example/fictional-character.png"],
  "reference_declarations": [
    {"path": "/input_images/0", "kind": "ai_generated_fictional_character"}
  ],
  "prepare_references": "on_rejection"
}
```

Add these fields to an ordinary video request. Declare only images the caller knows are AI-generated fictional characters. A declaration does not establish consent for a real person's likeness or guarantee that an image will pass provider validation. Do not infer a declaration from appearance or a prompt.

`on_rejection` is the default: prepare only after a verified eligible input rejection and retry once after settlement. `upfront` prepares all declared slots before submission. Canonical paths address image entries in `input_images`, `frame_images`, or `input_references`; use one canonical collection and avoid conflicting aliases. Up to eight distinct slots can be declared. Undeclared requests use ordinary video generation.

Submission returns the same stable `job_id` while the worker advances through `preparing_references`, `submitting`, `polling`, and `settling`. Polling reads status; it does not trigger generation. Completion includes authenticated content URLs and acknowledged charges. Unsupported app/model combinations return `UNSUPPORTED_REFERENCE_PREPARATION`. Changed image bytes, unavailable or rejected assets, and capacity exhaustion may fail preparation. A timeout with unknown provider acceptance remains pending for reconciliation; do not submit another job merely because polling is slow.

Preparation sends declared images to an external generation provider for storage and validation. Registration is not separately charged in this release; video generation uses the app's normal credits and settled usage. Source URLs and prompts are removed from preparation records after 24 hours. Provider copies are queued for deletion when the last retained job reference is released, subject to active jobs and unresolved operations; provider deletion can therefore take longer. App deletion preserves cleanup obligations and unsettled billing evidence. URL inputs have no storage-object identity: deleting the original file does not immediately delete its provider copy. Use stable storage `objectId` values in your own app and resolve fresh download URLs when loading UI.

When retained-output delivery is enabled, prepared videos complete only after every output is copied into private app storage and settlement is acknowledged. Generated outputs count toward app and organization storage limits. Authenticated content endpoints support one byte range and return 410 after the stored output is deleted. Keep the stable job ID for future content loads; older jobs can still depend on provider retention. App copies exclude prepared-video history.

There is no character-library dashboard. Preparation eligibility and resource limits are deployment-controlled. For troubleshooting, inspect the returned stage and sanitized error, verify the declaration and unchanged image bytes, and contact the operator for unresolved acceptance or cleanup.
