# Model Metadata Sync Dialog Design

## Goal

Replace the repeated “restore automatic detection” actions in model settings with one predictable metadata sync flow. The user chooses which automatically inferred fields to copy into the open settings form, reviews the result, and persists everything with the existing outer Save action.

## Interaction

- Show one icon-only “Sync model parameters” button beside the automatic/manual metadata tag in the model header.
- Remove all whole-model and per-field “restore automatic detection” links from the settings form.
- Clicking the icon performs local metadata inference and opens a nested dialog without closing the model settings dialog or writing the database.
- The nested dialog shows a checkbox table with field name, current value, and inferred value.
- Fields whose values differ are selected by default. Equal fields remain available but unselected. Fields without inferred data are disabled and display “No catalog data”.
- “Sync selected parameters” copies selected inferred values into the outer form draft and changes those fields from user-owned to automatic metadata. It does not persist.
- The outer Save action persists the combined manual edits and synchronized fields. The outer Cancel action discards both.

## Fields

The table covers model type, capabilities, context window, maximum output tokens, system-role compatibility, sampling-parameter omission, and reasoning options. Model type and capabilities remain separate selections even though changing model type sanitizes capabilities.

## Data and Failure Handling

- Extend `infer_model_metadata` with `automaticOnly`. It still reads only memory, cache, or the built-in catalog and does not start a network refresh.
- Automatic-only inference preserves identity, presentation fields, non-metadata request overrides, and fields explicitly sourced from the provider. It clears every other metadata field before applying exact catalog data, heuristics, and safe defaults. A legacy model without metadata state treats all existing metadata values as user-owned and clears them from the inference seed.
- A field is selectable when its inferred source is `catalog`, `provider`, or `heuristic`. The `default` source is selectable only for model type and capabilities; optional token, Boolean, and reasoning fields with `default` source mean “No catalog data”.
- Exact unsupported catalog modes display the existing unsupported reason, disable every row, and disable confirmation.
- Keep disjoint manual and automatic field sets in the outer form. Applying synchronization adds selected fields to the automatic set and removes them from the manual set. A later manual edit performs the inverse. Reopening and confirming the nested dialog accumulates automatic fields; leaving a row unchecked does not revert an earlier draft change.
- Initialize both sets as empty when the outer dialog opens; they record only ownership changes made in the current edit session. An untouched legacy model therefore keeps `metadata_state: null` when saved.
- Nested Cancel changes nothing. Outer Cancel discards both sets. Save failure keeps the outer draft and both sets. The automatic/manual header tag reflects the draft state.
- On Save, send both `userFields` and `automaticFields`. The backend rejects intersecting sets, requires every automatic field to carry a non-user source in the submitted metadata state, marks user fields, and atomically persists the complete model.
- Applying at least one selected field copies the candidate metadata schema version. It copies a non-null candidate catalog key and mode together, but a provider/heuristic candidate without a catalog match does not erase existing catalog provenance. Applying no fields leaves all model-level provenance unchanged.
- If inference fails, keep the outer dialog open and show the existing non-destructive error message.
- If no field can be synchronized, show the table and disable the confirmation action.

## Field Semantics

- Apply model type first. If capabilities are also selected, apply and sanitize inferred capabilities against the final type. If capabilities are not selected but a type change invalidates them, sanitize the current capabilities and mark that necessary capability change as user-owned. Synchronizing capabilities alone sanitizes them against the unchanged current type.
- Preserve the distinction between an absent Boolean and an inferred `false`. Switches render absent as off but do not write `false` unless the user changes the switch or synchronization supplies an explicit value.
- A null token value with no non-default source is unavailable, not an automatic clear operation.
- Compare capabilities and reasoning options as order-independent sets. A catalog-sourced empty reasoning option array is available and means clear; a missing/default array is unavailable.
- The reasoning row maps to `param_overrides.reasoning_options`. Saving merges the existing overrides and replaces only edited metadata/request fields, preserving `reasoning_default` and unrelated overrides.

## Tests

- The header has one sync icon and no repeated restore links.
- Opening and canceling the nested dialog does not mutate or close the outer dialog.
- Changed, equal, and unavailable rows receive the correct default checkbox states.
- Selecting fields updates only the outer draft; outer Cancel discards and outer Save persists.
- Manual fields not selected remain user-owned; selected fields regain inferred source metadata.
- Type/capability dependency, nullable token values, Boolean `false`, and reasoning option arrays round-trip correctly.
