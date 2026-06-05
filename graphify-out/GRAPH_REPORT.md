# Graph Report - .  (2026-06-05)

## Corpus Check
- 108 files · ~214,375 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1106 nodes · 1769 edges · 29 communities detected
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 301 edges (avg confidence: 0.8)
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
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]

## God Nodes (most connected - your core abstractions)
1. `json()` - 55 edges
2. `package:flutter/material.dart` - 36 edges
3. `dart:convert` - 35 edges
4. `authenticate()` - 35 edges
5. `dispatch()` - 32 edges
6. `isErr()` - 31 edges
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
- `csamGate()` --calls--> `json()`  [INFERRED]
  consumers/src/csam.ts → signaling/src/index.ts
- `classifyCheap()` --calls--> `json()`  [INFERRED]
  consumers/src/moderation.ts → signaling/src/index.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (111): _action, Align, _applyEdit, _applyVote, _attach, _attachItem, _bubble, build (+103 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (93): ApiAuth, _eventId, h, _randomHex, _sha256Hex, _traceId, _box, build (+85 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (91): AvaLogo, _bare, _box, build, Center, _done, _eyeToggle, _footerLink (+83 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (73): cancelDeletion(), deleteAccount(), backup(), call(), callStatus(), communities(), communityJoin(), communityObj() (+65 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (74): api_auth.dart, _activeUser, _capture, ClerkClient, ClerkStep, ClerkUser, _deriveDomain, FlutterSecureStorage (+66 more)

### Community 5 - "Community 5"
Cohesion: 0.03
Nodes (65): _bigIntTo32, _bytesToBigInt, calcPaddedLen, _chacha, _concat, _constEq, conversationKey, encrypt (+57 more)

### Community 6 - "Community 6"
Cohesion: 0.03
Nodes (58): ChatMedia, fromEnvelope, MediaService, MediaUploadException, _backup, build, _copyRow, _delete (+50 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (44): apnsConfigured(), b64url(), b64urlBytes(), importP8(), providerToken(), sendApns(), toString, Text (+36 more)

### Community 8 - "Community 8"
Cohesion: 0.04
Nodes (47): AnimatedContainer, _appsSetup, _body, build, Column, _contacts, Container, _dot (+39 more)

### Community 9 - "Community 9"
Cohesion: 0.04
Nodes (39): appByKey, AppDef, Avatar, build, Container, AvaLogo, _AvaLogoPainter, build (+31 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (43): add_contact_sheet.dart, _activeAdd, _activeAvatar, build, CallsScreen, Chat, ChatListScreen, _ChatListScreenState (+35 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (41): _AddContactSheet, _AddContactSheetState, build, _byIdBody, Center, dispose, Icon, ListTile (+33 more)

### Community 12 - "Community 12"
Cohesion: 0.1
Nodes (15): has, CallRoom, bech32Encode(), convertBits(), hexToNpub(), hrpExpand(), polymod(), cartesian() (+7 more)

### Community 13 - "Community 13"
Cohesion: 0.1
Nodes (28): csamCheckHash(), csamGate(), handleCsam(), permBan(), reportCsam(), toBase64(), addBlockedPerceptual(), classify() (+20 more)

### Community 14 - "Community 14"
Cohesion: 0.06
Nodes (29): _btn, build, CallScreen, _CallScreenState, dispose, _end, _endWith, _fetchIce (+21 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (26): _badge, build, _chips, _drop, ExploreHome, _ExploreHomeState, GestureDetector, Icon (+18 more)

### Community 16 - "Community 16"
Cohesion: 0.08
Nodes (23): build, dispose, Icon, initState, jsonDecode, LiveScreen, _LiveScreenState, _reset (+15 more)

### Community 17 - "Community 17"
Cohesion: 0.19
Nodes (15): clamp(), embed(), extract(), handleBrain(), parseExtracted(), upsertEntity(), upsertRelationship(), deleteR2Prefix() (+7 more)

### Community 18 - "Community 18"
Cohesion: 0.27
Nodes (1): UserBrain

### Community 19 - "Community 19"
Cohesion: 0.26
Nodes (11): bech32Decode(), bech32Encode(), convertBits(), hex(), hexToNpub(), hrpExpand(), npubToHex(), polymod() (+3 more)

### Community 20 - "Community 20"
Cohesion: 0.22
Nodes (6): patch_desugaring(), patch_firebase(), patch_root_compile_sdk(), Apply the google-services Gradle plugin + place google-services.json., flutter_local_notifications requires core library desugaring., flutter_webrtc pins a low compileSdk; override every subproject to 35.

### Community 21 - "Community 21"
Cohesion: 0.5
Nodes (1): sdks()

### Community 22 - "Community 22"
Cohesion: 0.67
Nodes (2): Chat, seedGradient

### Community 23 - "Community 23"
Cohesion: 1.0
Nodes (1): Product

### Community 24 - "Community 24"
Cohesion: 1.0
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 1.0
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 1.0
Nodes (0): 

### Community 27 - "Community 27"
Cohesion: 1.0
Nodes (0): 

### Community 28 - "Community 28"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **689 isolated node(s):** `JoinScreen`, `_JoinScreenState`, `build`, `Scaffold`, `Text` (+684 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 23`** (2 nodes): `product.dart`, `Product`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (2 nodes): `aiText()`, `ai.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 25`** (2 nodes): `test_relay.mjs`, `hex()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (1 nodes): `config.dart`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 27`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `package:flutter/material.dart` connect `Community 9` to `Community 0`, `Community 1`, `Community 2`, `Community 6`, `Community 8`, `Community 10`, `Community 11`, `Community 14`, `Community 15`, `Community 16`?**
  _High betweenness centrality (0.218) - this node is a cross-community bridge._
- **Why does `dart:convert` connect `Community 4` to `Community 0`, `Community 1`, `Community 2`, `Community 5`, `Community 6`, `Community 10`, `Community 14`, `Community 16`?**
  _High betweenness centrality (0.196) - this node is a cross-community bridge._
- **Why does `../../core/theme.dart` connect `Community 2` to `Community 0`, `Community 1`, `Community 6`, `Community 8`, `Community 10`, `Community 11`, `Community 14`, `Community 15`, `Community 16`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Are the 51 inferred relationships involving `json()` (e.g. with `getAccessToken()` and `csamGate()`) actually correct?**
  _`json()` has 51 INFERRED edges - model-reasoned connections that need verification._
- **Are the 32 inferred relationships involving `authenticate()` (e.g. with `hexToNpub()` and `metaSession()`) actually correct?**
  _`authenticate()` has 32 INFERRED edges - model-reasoned connections that need verification._
- **Are the 29 inferred relationships involving `dispatch()` (e.g. with `preflight()` and `json()`) actually correct?**
  _`dispatch()` has 29 INFERRED edges - model-reasoned connections that need verification._
- **What connects `JoinScreen`, `_JoinScreenState`, `build` to the rest of the system?**
  _689 weakly-connected nodes found - possible documentation gaps or missing edges._