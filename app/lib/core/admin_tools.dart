import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'account_storage.dart';

/// The product a signed-in account belongs to. Drives which management tools
/// appear in the sidebar. For now this is stored locally (preview); later it
/// will come from the server (Clerk `publicMetadata.account_kind` / tenant role).
enum AccountKind { personal, parent, enterprise }

extension AccountKindX on AccountKind {
  String get wire => switch (this) {
        AccountKind.personal => 'personal',
        AccountKind.parent => 'parent',
        AccountKind.enterprise => 'enterprise',
      };
  static AccountKind fromWire(String? s) => switch (s) {
        'parent' => AccountKind.parent,
        'enterprise' => AccountKind.enterprise,
        _ => AccountKind.personal,
      };
}

/// One management tool shown under a Parent/Enterprise header in the sidebar.
/// `key` is the destination passed to the shell's router (currently → ComingSoon).
class AdminTool {
  final String key;
  final String name;
  final String tagline;
  final IconData icon;
  final Color color;
  const AdminTool(this.key, this.name, this.tagline, this.icon, this.color);
}

// ── Parent tools (custodial family accounts) ────────────────────────────────
// Dummy destinations for now — wired to "coming soon" screens until built.
const kParentTools = <AdminTool>[
  AdminTool('parent.add_child', 'Add child account', 'Create a managed account for your kid',
      Icons.person_add_alt_1, Color(0xFF08C4C4)),
  AdminTool('parent.children', 'My children', 'Manage each child & their apps',
      Icons.family_restroom, Color(0xFF7C5CFC)),
  AdminTool('parent.activity', 'Activity overview', 'See posts, contacts & daily digest',
      Icons.insights, Color(0xFF22C9C0)),
  AdminTool('parent.app_controls', 'Block apps & sites', 'Allow or block apps per child',
      Icons.block, Color(0xFFFF3B30)),
  AdminTool('parent.contacts', 'Contact approvals', 'Approve who your child connects with',
      Icons.how_to_reg, Color(0xFF10B981)),
  AdminTool('parent.screen_time', 'Screen time', 'Set daily limits & quiet hours',
      Icons.hourglass_bottom, Color(0xFFEAB308)),
  AdminTool('parent.safety', 'Safety alerts', 'Flagged content & stranger warnings',
      Icons.shield_outlined, Color(0xFFFF6036)),
];

// ── Enterprise tools (org-owned accounts; super-admin) ──────────────────────
const kEnterpriseTools = <AdminTool>[
  AdminTool('ent.add_user', 'Add employee', 'Provision an org-owned account',
      Icons.person_add_alt_1, Color(0xFF0A66C2)),
  AdminTool('ent.employees', 'Employees', 'Directory of your team',
      Icons.groups_2, Color(0xFF6C5CE7)),
  AdminTool('ent.teams', 'Teams & roles', 'Group employees & assign admins',
      Icons.account_tree, Color(0xFF7C5CFC)),
  AdminTool('ent.manage_apps', 'Manage apps', 'Grant or block apps per employee',
      Icons.apps, Color(0xFF22C9C0)),
  AdminTool('ent.social_group', 'Company group', 'Internal social user group',
      Icons.diversity_3, Color(0xFFE1306C)),
  AdminTool('ent.offboard', 'Offboard employee', 'Revoke access; data stays with you',
      Icons.logout, Color(0xFFFF3B30)),
  AdminTool('ent.billing', 'Seats & billing', 'Manage licenses & plan',
      Icons.credit_card, Color(0xFFEAB308)),
  AdminTool('ent.audit', 'Audit log', 'Who did what, when',
      Icons.fact_check_outlined, Color(0xFF10B981)),
];

List<AdminTool> toolsFor(AccountKind kind) => switch (kind) {
      AccountKind.parent => kParentTools,
      AccountKind.enterprise => kEnterpriseTools,
      AccountKind.personal => const [],
    };

String headerFor(AccountKind kind) => switch (kind) {
      AccountKind.parent => 'PARENT',
      AccountKind.enterprise => 'ENTERPRISE',
      AccountKind.personal => '',
    };

AdminTool? adminToolByKey(String key) {
  for (final t in [...kParentTools, ...kEnterpriseTools]) {
    if (t.key == key) return t;
  }
  return null;
}

/// Persists the account kind locally. Preview/source-of-truth shim until the
/// registration flow + server tenancy set this for real.
class AccountKindStore {
  static const _k = 'account_kind';
  final FlutterSecureStorage _s;
  AccountKindStore([FlutterSecureStorage? s])
      : _s = s ??
            const FlutterSecureStorage(mOptions: MacOsOptions(useDataProtectionKeyChain: false), 
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  Future<AccountKind> load() async =>
      AccountKindX.fromWire(await readScoped(_s, _k));

  Future<void> set(AccountKind kind) =>
      _s.write(key: scopedKey(_k), value: kind.wire);
}
