# Graph Report - .  (2026-06-05)

## Corpus Check
- 113 files · ~218,239 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1149 nodes · 1899 edges · 27 communities detected
- Extraction: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS · INFERRED: 355 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]

## God Nodes (most connected - your core abstractions)
1. `json()` - 68 edges
2. `authenticate()` - 41 edges
3. `dispatch()` - 39 edges
4. `isErr()` - 37 edges
5. `package:flutter/material.dart` - 36 edges
6. `dart:convert` - 35 edges
7. `../../core/theme.dart` - 27 edges
8. `RelayRoom` - 20 edges
9. `metaSession()` - 18 edges
10. `../core/config.dart` - 17 edges

## Surprising Connections (you probably didn't know these)
- `sdks()` --calls--> `search()`  [INFERRED]
  avaconsult/tool/postcreate.py → worker/src/routes/api.ts
- `matchContacts()` --calls--> `chunk()`  [INFERRED]
  worker/src/routes/api.ts → relay/src/relay_do.ts
- `json()` --calls--> `getAccessToken()`  [INFERRED]
  signaling/src/index.ts → consumers/src/fcm.ts
- `json()` --calls--> `csamGate()`  [INFERRED]
  signaling/src/index.ts → consumers/src/csam.ts
- `json()` --calls--> `classifyCheap()`  [INFERRED]
  signaling/src/index.ts → consumers/src/moderation.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (180): ApiAuth, _eventId, h, _randomHex, _sha256Hex, _traceId, _AddContactSheet, _AddContactSheetState (+172 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (124): api_auth.dart, _activeUser, _capture, ClerkClient, ClerkStep, ClerkUser, _deriveDomain, FlutterSecureStorage (+116 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (111): _action, Align, _applyEdit, _applyVote, _attach, _attachItem, _bubble, build (+103 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (86): cancelDeletion(), deleteAccount(), backup(), call(), callStatus(), communities(), communityJoin(), communityObj() (+78 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (58): apnsConfigured(), b64url(), b64urlBytes(), importP8(), providerToken(), sendApns(), toString, Text (+50 more)

### Community 5 - "Community 5"
Cohesion: 0.03
Nodes (65): appByKey, AppDef, Avatar, build, Container, AvaLogo, _AvaLogoPainter, build (+57 more)

### Community 6 - "Community 6"
Cohesion: 0.03
Nodes (62): _btn, build, CallScreen, _CallScreenState, dispose, _end, _endWith, _fetchIce (+54 more)

### Community 7 - "Community 7"
Cohesion: 0.04
Nodes (47): AnimatedContainer, _appsSetup, _body, build, Column, _contacts, Container, _dot (+39 more)

### Community 8 - "Community 8"
Cohesion: 0.04
Nodes (44): AvaLogo, _bare, _box, build, Center, _done, _eyeToggle, _footerLink (+36 more)

### Community 9 - "Community 9"
Cohesion: 0.08
Nodes (16): has, CallRoom, Room, bech32Encode(), convertBits(), hexToNpub(), hrpExpand(), polymod() (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (43): add_contact_sheet.dart, _activeAdd, _activeAvatar, build, CallsScreen, Chat, ChatListScreen, _ChatListScreenState (+35 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (39): _backup, build, _copyRow, _delete, Divider, Scaffold, _section, SettingsScreen (+31 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (26): csamCheckHash(), csamGate(), handleCsam(), permBan(), reportCsam(), toBase64(), addBlockedPerceptual(), classify() (+18 more)

### Community 13 - "Community 13"
Cohesion: 0.07
Nodes (25): _bigIntTo32, _bytesToBigInt, calcPaddedLen, _chacha, _concat, _constEq, conversationKey, encrypt (+17 more)

### Community 14 - "Community 14"
Cohesion: 0.15
Nodes (19): clamp(), embed(), extract(), handleBrain(), parseExtracted(), upsertEntity(), upsertRelationship(), aiText() (+11 more)

### Community 15 - "Community 15"
Cohesion: 0.27
Nodes (1): UserBrain

### Community 16 - "Community 16"
Cohesion: 0.41
Nodes (1): WalletDO

### Community 17 - "Community 17"
Cohesion: 0.22
Nodes (6): patch_desugaring(), patch_firebase(), patch_root_compile_sdk(), Apply the google-services Gradle plugin + place google-services.json., flutter_local_notifications requires core library desugaring., flutter_webrtc pins a low compileSdk; override every subproject to 35.

### Community 18 - "Community 18"
Cohesion: 0.47
Nodes (1): StreamSessionDO

### Community 19 - "Community 19"
Cohesion: 0.5
Nodes (1): sdks()

### Community 20 - "Community 20"
Cohesion: 0.67
Nodes (2): Chat, seedGradient

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (1): Product

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (0): 

### Community 23 - "Community 23"
Cohesion: 1.0
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 1.0
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 1.0
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **689 isolated node(s):** `JoinScreen`, `_JoinScreenState`, `build`, `Scaffold`, `Text` (+684 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 21`** (2 nodes): `product.dart`, `Product`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (2 nodes): `aiText()`, `ai.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 23`** (2 nodes): `test_relay.mjs`, `hex()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (1 nodes): `config.dart`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 25`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dart:convert` connect `Community 1` to `Community 0`, `Community 2`, `Community 6`, `Community 10`, `Community 11`, `Community 13`?**
  _High betweenness centrality (0.258) - this node is a cross-community bridge._
- **Why does `package:flutter/material.dart` connect `Community 5` to `Community 0`, `Community 1`, `Community 2`, `Community 6`, `Community 7`, `Community 8`, `Community 10`, `Community 11`?**
  _High betweenness centrality (0.197) - this node is a cross-community bridge._
- **Why does `Text` connect `Community 4` to `Community 3`, `Community 7`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Are the 64 inferred relationships involving `json()` (e.g. with `getAccessToken()` and `csamGate()`) actually correct?**
  _`json()` has 64 INFERRED edges - model-reasoned connections that need verification._
- **Are the 38 inferred relationships involving `authenticate()` (e.g. with `hexToNpub()` and `metaSession()`) actually correct?**
  _`authenticate()` has 38 INFERRED edges - model-reasoned connections that need verification._
- **Are the 36 inferred relationships involving `dispatch()` (e.g. with `preflight()` and `json()`) actually correct?**
  _`dispatch()` has 36 INFERRED edges - model-reasoned connections that need verification._
- **Are the 36 inferred relationships involving `isErr()` (e.g. with `walletTopup()` and `walletSpend()`) actually correct?**
  _`isErr()` has 36 INFERRED edges - model-reasoned connections that need verification._