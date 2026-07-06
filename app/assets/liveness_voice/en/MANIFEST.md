# Liveness V3 — English voice clips (bundled in APK)

These are the 15 pre-recorded Ava voice lines for the voice-guided liveness flow
(Specs/LIVENESS-V3-VOICE-GUIDED-PLAN-DRAFT.md §1). English ships in the APK so a
check always works offline; other languages download from the CDN at
`https://blossom.avatok.ai/voice-packs/liveness/<lang>/<file>`.

Generate one nice female "Ava" voice (multilingual TTS, same voice per language)
for each line below. Encode as **AAC `.m4a`, mono, ~64 kbps** (keeps a 15-clip
pack under ~1 MB). Drop the files into this folder with the EXACT filenames — they
must match `LivenessPackManifest` in
`app/lib/features/identity/liveness_v3/voice_packs.dart`.

| instruction     | filename              | English line                                                  |
|-----------------|-----------------------|---------------------------------------------------------------|
| intro           | intro.m4a             | Hi, I'm Ava. Prop your phone up so I can see your face.        |
| moveCloser      | move_closer.m4a       | Come a bit closer.                                            |
| moveBack        | move_back.m4a         | Move back a little.                                           |
| faceLeft        | face_left.m4a         | Turn your head left.                                         |
| faceRight       | face_right.m4a        | Turn your head right.                                        |
| lookUp          | look_up.m4a           | Look up a little.                                            |
| lookDown        | look_down.m4a         | Look down a little.                                          |
| good            | good.m4a              | Perfect.                                                    |
| holdStill       | hold_still.m4a        | Hold still — recording now.                                  |
| faceNotFound    | face_not_found.m4a    | Place your face in the frame.                                |
| lowLight        | low_light.m4a         | Move somewhere brighter.                                    |
| removeGlasses   | remove_glasses.m4a    | Please remove your glasses.                                 |
| onlyOnePerson   | only_one_person.m4a   | Make sure only you are in the frame.                        |
| cameraBlocked   | camera_blocked.m4a    | Something is covering the camera.                           |
| done            | done.m4a              | That's it! I'm checking now.                                |

Until the real audio is dropped in, the code degrades gracefully: a missing clip
falls back to system TTS speaking the localized on-screen string, then to the
English clip + on-screen text — the flow is never blocked on a voice pack.
