# Host onboarding (native app)

Built in HF-NATIVE-9 (part A) with the shared identity checks of HF-NATIVE-8 (`lib/features/kyc/`).
Part B (HF-NATIVE-10) plugs its steps into the flow described here. Nothing in part A needs to change for that.

Route: `/host/onboarding?step=<key>` (needs sign-in). `?dl=return` is the DigiLocker return link.
The flag `hostOnboardingEnabled` off gives a calm "Coming soon" panel (the worker answers `404 not_enabled`).

## The 16 steps

Same keys and order as the website (`web/src/islands/host-onboarding/data.ts`), so links like `?step=aadhaar` work on both.

| Key | Group | Built by |
|---|---|---|
| `welcome`, `phone`, `aadhaar`, `selfie`, `payout` | Start, Verify | part A (`ui/steps/`) |
| `avatar`, `about`, `languages`, `topics`, `price`, `hours` | Profile | **part B** |
| `voice` | Voice | **part B** |
| `review`, `generating`, `preview`, `done` | Finish | **part B** |

The list lives in `flow/onboarding_steps.dart` (`kOnboardingSteps`, `OnboardingKeys`). Every step has an `isDone(OnboardingServerState)`
rule. Part B may refine the rule of its own steps there (it is the only shared file part B should edit, and only those lines).

## How part B plugs in (three things)

1. Write a widget per step. It gets an `OnboardingStepContext`:

   ```dart
   class AvatarStep extends StatelessWidget {
     const AvatarStep({super.key, required this.ctx});
     final OnboardingStepContext ctx;
     ...
   }
   ```

2. Register the builders in **`part_b/part_b_steps.dart`**:

   ```dart
   final Map<String, OnboardingStepBuilder> partBStepBuilders = <String, OnboardingStepBuilder>{
     OnboardingKeys.avatar: (context, ctx) => AvatarStep(ctx: ctx),
     OnboardingKeys.about: (context, ctx) => AboutStep(ctx: ctx),
     // ...
   };
   ```

   `ui/step_registry.dart` merges part A and part B into `onboardingStepBuildersProvider`. A key nobody registered shows
   "This step is coming" (so the flow is walkable before part B lands). Part B's code goes in `part_b/`.
   If your own `part_b_steps.dart` already exists, keep your file: the only contract is the exported
   `Map<String, OnboardingStepBuilder> partBStepBuilders`.

3. In a step, use `ctx`:

   | Member | What it is |
   |---|---|
   | `ctx.state` | `OnboardingServerState`: `host` (raw `GET /api/hosts/me` host map), `kyc`, `media`, `job`, `phoneVerified`. Helpers: `hostString(key)`, `hostStrings(key)`, `hostNum(key)`, `hostMap(key)`, `hostStatus`, `generated`. |
   | `ctx.next()` | Re-reads the server, then opens the following step. Call it when the step's own save succeeded. |
   | `ctx.goTo(key)` | Opens another step by key without waiting (for example `preview` after a retry). |
   | `ctx.refresh()` | Re-reads `GET /api/hosts/me` and returns the new state. The shell hands the new state to the step. |
   | `ctx.digiLockerReturn` | Only true on the Aadhaar step after `?dl=return`. Part B can ignore it. |

Use `OnboardingStepPage(title:, lead:, children:)` (`ui/widgets/step_page.dart`) for the standard step layout: scrollable, 20 dp gutter,
Nunito title. The shell draws the progress header and the Back button; steps do not.

For the microphone step wrap the recorder in the shared permission flow (explainer, Android prompt, denied with "Open settings",
re-check when the person comes back):

```dart
PermissionGate(
  permissions: const [HfPermission.mic],
  icon: Icons.mic_rounded,
  title: KycCopy.micTitle,
  body: KycCopy.micWhy,
  child: YourRecorder(),
)
```

`PermissionGate` sends `hf_app_permission {kind: 'mic', result}` by itself. Tests fake it with
`permissionServiceProvider.overrideWithValue(FakePermissionService())` (`test/support/kyc_fakes.dart`).

## Where it opens (resume)

`resumeStepKey(OnboardingServerState)`:

- host status `pending_review` or `live` opens `done`; `generating` opens `generating`; `rejected` or `paused` opens `preview`;
- otherwise the first step in order whose `isDone` is false.

`?step=<key>` can go **back** to an earlier step, never past the resume step (`startStepKey`): a link cannot skip the identity checks.
An unknown key resumes. The Back button goes one step back; at the first step it pops, or goes Home when the screen was opened by a link.

## State

`onboardingStateProvider` = `GET /api/hosts/me` (`{host, kyc, media, job}`) plus `GET /api/account/phone/status`
(a failure of the second falls back to the signed-in session's `whatsappVerified`). Do not read it directly in a step:
use `ctx.state` and `ctx.refresh()`.

## Tests

- `test/features/host_onboarding/onboarding_steps_test.dart`: the resume rules, `?step=` clamping, state parsing.
- `test/features/host_onboarding/host_onboarding_screen_test.dart`: the shell, each part A step, the part B placeholder, and a part B builder override.
  A part B test can do the same: override `onboardingStepBuildersProvider`, or register real builders and open
  `/host/onboarding?step=<key>` with a stubbed `GET /api/hosts/me`.

## Things only a phone can show

Camera, microphone and permission prompts, the real 10 second recording, the DigiLocker Custom Tab round trip, and the
custom-scheme return link. The tests fake all of these behind `PermissionService`, `SelfieRecorder` and `LinkOpener`.
