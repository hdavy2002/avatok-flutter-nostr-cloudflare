# Graph Report - .  (2026-06-05)

## Corpus Check
- 127 files · ~230,762 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1264 nodes · 2340 edges · 27 communities detected
- Extraction: 73% EXTRACTED · 27% INFERRED · 0% AMBIGUOUS · INFERRED: 628 edges (avg confidence: 0.8)
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
1. `json()` - 102 edges
2. `dispatch()` - 69 edges
3. `authenticate()` - 68 edges
4. `isErr()` - 64 edges
5. `package:flutter/material.dart` - 36 edges
6. `dart:convert` - 35 edges
7. `../../core/theme.dart` - 27 edges
8. `metaDb()` - 26 edges
9. `metaSession()` - 23 edges
10. `track()` - 22 edges

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
Nodes (165): add_contact_sheet.dart, _AddContactSheet, _AddContactSheetState, build, _byIdBody, Center, dispose, Icon (+157 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (133): api_auth.dart, _activeUser, _capture, ClerkClient, ClerkStep, ClerkUser, _deriveDomain, FlutterSecureStorage (+125 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (120): cancelDeletion(), deleteAccount(), agentTask(), approveInbox(), converse(), getInbox(), getInboxItem(), listPersonas() (+112 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (80): handleAgent(), call(), hdr(), hx(), mk(), apnsConfigured(), b64url(), b64urlBytes() (+72 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (107): ApiAuth, _eventId, h, _randomHex, _sha256Hex, _traceId, _box, build (+99 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (111): _action, Align, _applyEdit, _applyVote, _attach, _attachItem, _bubble, build (+103 more)

### Community 6 - "Community 6"
Cohesion: 0.02
Nodes (102): AvaLogo, _bare, _box, build, Center, _done, _eyeToggle, _footerLink (+94 more)

### Community 7 - "Community 7"
Cohesion: 0.03
Nodes (65): appByKey, AppDef, Avatar, build, Container, AvaLogo, _AvaLogoPainter, build (+57 more)

### Community 8 - "Community 8"
Cohesion: 0.03
Nodes (57): copyWith, FlutterSecureStorage, Group, GroupStore, isAdmin, newId, _bigIntTo32, _bytesToBigInt (+49 more)

### Community 9 - "Community 9"
Cohesion: 0.08
Nodes (16): has, CallRoom, Room, bech32Encode(), convertBits(), hexToNpub(), hrpExpand(), polymod() (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (20): clamp(), embed(), extract(), handleBrain(), parseExtracted(), upsertEntity(), upsertRelationship(), ConversationDO (+12 more)

### Community 11 - "Community 11"
Cohesion: 0.12
Nodes (27): csamCheckHash(), csamGate(), handleCsam(), permBan(), reportCsam(), toBase64(), addBlockedPerceptual(), classify() (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.27
Nodes (1): UserBrain

### Community 13 - "Community 13"
Cohesion: 0.41
Nodes (1): WalletDO

### Community 14 - "Community 14"
Cohesion: 0.47
Nodes (2): AgentDO, today()

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (6): patch_desugaring(), patch_firebase(), patch_root_compile_sdk(), Apply the google-services Gradle plugin + place google-services.json., flutter_local_notifications requires core library desugaring., flutter_webrtc pins a low compileSdk; override every subproject to 35.

### Community 16 - "Community 16"
Cohesion: 0.36
Nodes (7): b64ToStr(), b64urlToBytes(), getJwks(), serializeId(), tagVal(), verifyClerk(), verifyNip98()

### Community 17 - "Community 17"
Cohesion: 0.43
Nodes (7): base(), createQuote(), createRecipient(), createTransfer(), fundTransfer(), wise(), wiseConfigured()

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

- **Why does `dart:convert` connect `Community 1` to `Community 0`, `Community 4`, `Community 5`, `Community 6`, `Community 8`?**
  _High betweenness centrality (0.228) - this node is a cross-community bridge._
- **Why does `package:flutter/material.dart` connect `Community 7` to `Community 0`, `Community 1`, `Community 4`, `Community 5`, `Community 6`?**
  _High betweenness centrality (0.202) - this node is a cross-community bridge._
- **Why does `Text` connect `Community 3` to `Community 17`, `Community 2`, `Community 4`?**
  _High betweenness centrality (0.177) - this node is a cross-community bridge._
- **Are the 98 inferred relationships involving `json()` (e.g. with `getAccessToken()` and `csamGate()`) actually correct?**
  _`json()` has 98 INFERRED edges - model-reasoned connections that need verification._
- **Are the 66 inferred relationships involving `dispatch()` (e.g. with `preflight()` and `json()`) actually correct?**
  _`dispatch()` has 66 INFERRED edges - model-reasoned connections that need verification._
- **Are the 65 inferred relationships involving `authenticate()` (e.g. with `hexToNpub()` and `metaSession()`) actually correct?**
  _`authenticate()` has 65 INFERRED edges - model-reasoned connections that need verification._
- **Are the 63 inferred relationships involving `isErr()` (e.g. with `walletTopup()` and `walletSpend()`) actually correct?**
  _`isErr()` has 63 INFERRED edges - model-reasoned connections that need verification._