# Demo hosts (HF-DEMO)

A pretend booking flow so the whole thing can be felt on a phone before real hosts exist: two demo hosts
(Neha, online; Rohan, busy) on Discover, their profiles, the confirm sheet, a simulated call, the summary and
a review. No network, no wallet change, and the only telemetry is `hf_demo_flow {step}`.

Everything demo-specific is in this folder. Every line outside it is marked `// [HF-DEMO] remove with lib/features/demo`.

Quick off switch: set `kDemoEnabled = false` in `demo_data.dart` (the hooks become no-ops, the hosts disappear).

## To delete it for good

1. Delete `lib/features/demo/` and `test/features/demo/`.
2. Delete (or undo) every line that says `[HF-DEMO]`. Find them with `grep -rn "HF-DEMO" lib test`:

| File | What the hook does |
| --- | --- |
| `lib/features/explore/data/explore_controller.dart` | `withDemoHosts(...)` puts the demo hosts first on the plain list |
| `lib/features/explore/widgets/host_image.dart` | `asset://` pictures in `HostAvatar` |
| `lib/features/explore/widgets/host_card_view.dart` | the Demo chip next to the name on the card |
| `lib/features/explore/widgets/intro_player.dart` | `DemoAwareIntroAudio` wraps the speaker (fake 20 s clip) |
| `lib/core/widgets/hf_photo_card.dart` | `asset://` pictures in the big card photo |
| `lib/features/host_profile/data/host_profile_providers.dart` | profile served for the demo slugs; no estimate, notify status or notify request for them |
| `lib/features/host_profile/data/intro_player.dart` | `DemoAwareIntroPlayer` (fake 20 s clip on the profile) |
| `lib/features/host_profile/ui/widgets/net_image.dart` | `asset://` pictures on the profile hero and gallery |
| `lib/features/host_profile/ui/widgets/profile_header.dart` | the Demo chip next to the name |
| `lib/features/call/ui/call_confirm_page.dart` | host name for a demo slug, no name request |
| `lib/features/call/ui/call_confirm_sheet.dart` | fake estimate (wallet ₹342, about 17 min), fake start, photo, calls-flag bypass |
| `lib/features/call/ui/call_screen.dart` | `/call/demo-call` opens `DemoCallScreen` |
| `lib/features/call/ui/call_avatar.dart` | `asset://` pictures in the call avatar |
| `lib/features/review/ui/review_screen.dart` | the demo call id: fake target, topics, and a fake successful send |
| `test/features/explore/explore_test_support.dart` | turns the demo hosts off for the Explore tests |

The pictures `assets/images/demo_*.webp` can be deleted too.
