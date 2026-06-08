import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/avatar_cache.dart';
import '../../core/apps.dart';
import '../../core/library_api.dart';
import '../../core/theme.dart';
import 'private_ingest.dart';

/// Visual metadata for the five system categories.
class _Cat {
  final String key;
  final String label;
  final IconData icon;
  final Color color;
  const _Cat(this.key, this.label, this.icon, this.color);
}

const _cats = <_Cat>[
  _Cat('image', 'Images', Icons.image, Color(0xFF22C9C0)),
  _Cat('video', 'Videos', Icons.movie, Color(0xFFFF3B30)),
  _Cat('document', 'Documents', Icons.description, Color(0xFFEAB308)),
  _Cat('audio', 'Music', Icons.music_note, Color(0xFF7C5CFC)),
  _Cat('other', 'Other', Icons.insert_drive_file, Color(0xFF737A86)),
];

_Cat _catOf(String k) => _cats.firstWhere((c) => c.key == k, orElse: () => _cats.last);

String _fmtBytes(int b) {
  if (b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = b.toDouble();
  var i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return '${v.toStringAsFixed(v >= 10 || i == 0 ? 0 : 1)} ${u[i]}';
}

/// AvaLibrary — the global, cross-app file manager. App roots → category folders
/// (+ user folders) → files. Local-first: paints the cached tree, then refreshes.
class AvaLibraryScreen extends StatefulWidget {
  const AvaLibraryScreen({super.key});
  @override
  State<AvaLibraryScreen> createState() => _AvaLibraryScreenState();
}

class _AvaLibraryScreenState extends State<AvaLibraryScreen> {
  LibraryTree? _tree;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final cached = await LibraryApi.cachedTree();
    if (cached != null && mounted) setState(() { _tree = cached; _loading = false; });
    try {
      final t = await LibraryApi.tree();
      if (mounted) setState(() { _tree = t; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final apps = _tree?.apps ?? const [];
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('AvaLibrary', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading && _tree == null
            ? const Center(child: CircularProgressIndicator())
            : apps.isEmpty
                ? _empty()
                : ListView(padding: const EdgeInsets.all(16), children: [
                    const Text('Your files across every AvaVerse app.',
                        style: TextStyle(color: AvaColors.sub, fontSize: 13)),
                    const SizedBox(height: 14),
                    for (final a in apps) _appCard(a),
                  ]),
      ),
    );
  }

  Widget _empty() => ListView(children: const [
        SizedBox(height: 120),
        Icon(Icons.folder_open, size: 64, color: AvaColors.line),
        SizedBox(height: 12),
        Center(child: Text('No files yet', style: TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w700))),
        SizedBox(height: 4),
        Center(child: Text('Send or receive a file in any app and it lands here.',
            style: TextStyle(color: AvaColors.sub, fontSize: 12))),
      ]);

  Widget _appCard(AppNode a) {
    final def = appByKey(a.app);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(16)),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        leading: Container(
          width: 44, height: 44,
          decoration: BoxDecoration(color: def.color.withOpacity(0.15), borderRadius: BorderRadius.circular(12)),
          child: Icon(def.icon, color: def.color),
        ),
        title: Text(def.name, style: const TextStyle(fontWeight: FontWeight.w800, color: AvaColors.ink)),
        subtitle: Text('${a.total} file${a.total == 1 ? '' : 's'} · ${_fmtBytes(a.bytes)}',
            style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
        trailing: const Icon(Icons.chevron_right, color: AvaColors.sub),
        onTap: () => Navigator.push(context, MaterialPageRoute(
            builder: (_) => _AppView(app: a.app, node: a, tree: _tree!))).then((_) => _load()),
      ),
    );
  }
}

/// One app root: its five category folders (with counts) + the user's folders.
class _AppView extends StatefulWidget {
  final String app;
  final AppNode node;
  final LibraryTree tree;
  const _AppView({required this.app, required this.node, required this.tree});
  @override
  State<_AppView> createState() => _AppViewState();
}

class _AppViewState extends State<_AppView> {
  late List<LibraryFolder> _folders;

  @override
  void initState() {
    super.initState();
    _folders = List.of(widget.tree.foldersByApp[widget.app] ?? const []);
    _refreshFolders();
  }

  Future<void> _refreshFolders() async {
    try {
      final f = await LibraryApi.folders(widget.app);
      if (mounted) setState(() => _folders = f);
    } catch (_) {}
  }

  Future<void> _newFolder() async {
    final name = await _promptName(context, 'New folder');
    if (name == null || name.isEmpty) return;
    await LibraryApi.createFolder(app: widget.app, name: name);
    _refreshFolders();
  }

  @override
  Widget build(BuildContext context) {
    final def = appByKey(widget.app);
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(def.name, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.brand,
        onPressed: _newFolder,
        icon: const Icon(Icons.create_new_folder_outlined),
        label: const Text('New folder'),
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text('CATEGORIES', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        for (final c in _cats)
          if ((widget.node.byCategory[c.key] ?? 0) > 0) _row(
            icon: c.icon, color: c.color, title: c.label,
            sub: '${widget.node.byCategory[c.key]} item${widget.node.byCategory[c.key] == 1 ? '' : 's'}',
            onTap: () => _openView(category: c.key, title: c.label),
          ),
        const SizedBox(height: 18),
        Row(children: [
          const Text('FOLDERS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
        ]),
        const SizedBox(height: 8),
        if (_folders.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('No folders yet — tap “New folder”.', style: TextStyle(color: AvaColors.sub, fontSize: 12)))
        else
          for (final f in _folders) _row(
            icon: Icons.folder, color: AvaColors.brand, title: f.name, sub: 'Folder',
            onTap: () => _openView(folder: f.id, title: f.name),
            onLong: () => _folderMenu(f),
          ),
        const SizedBox(height: 80),
      ]),
    );
  }

  void _openView({String? category, String? folder, required String title}) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => _FolderView(app: widget.app, category: category, folderId: folder, title: title, folders: _folders),
    )).then((_) => _refreshFolders());
  }

  Future<void> _folderMenu(LibraryFolder f) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(leading: const Icon(Icons.drive_file_rename_outline), title: const Text('Rename'), onTap: () => Navigator.pop(context, 'rename')),
        ListTile(leading: const Icon(Icons.delete_outline, color: AvaColors.danger),
            title: const Text('Delete folder', style: TextStyle(color: AvaColors.danger)),
            subtitle: const Text('Files move back to their category'), onTap: () => Navigator.pop(context, 'delete')),
      ])),
    );
    if (action == 'rename') {
      final name = await _promptName(context, 'Rename folder', initial: f.name);
      if (name != null && name.isNotEmpty) { await LibraryApi.renameFolder(f.id, name); _refreshFolders(); }
    } else if (action == 'delete') {
      await LibraryApi.deleteFolder(f.id);
      _refreshFolders();
    }
  }

  Widget _row({required IconData icon, required Color color, required String title, required String sub, required VoidCallback onTap, VoidCallback? onLong}) =>
      Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: ListTile(
          leading: Icon(icon, color: color),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, color: AvaColors.ink)),
          subtitle: Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
          trailing: const Icon(Icons.chevron_right, color: AvaColors.sub),
          onTap: onTap, onLongPress: onLong,
        ),
      );
}

/// A file listing: a category bucket or a user folder. Grid for images/videos,
/// list otherwise. Per-item actions: open, move, copy, delete.
class _FolderView extends StatefulWidget {
  final String app;
  final String? category;
  final String? folderId;
  final String title;
  final List<LibraryFolder> folders;
  const _FolderView({required this.app, this.category, this.folderId, required this.title, required this.folders});
  @override
  State<_FolderView> createState() => _FolderViewState();
}

class _FolderViewState extends State<_FolderView> {
  final List<LibraryItem> _items = [];
  bool _loading = true;
  bool _fetching = false;
  int? _cursor;
  bool _more = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_fetching) return; // guard against duplicate calls from the list sentinel
    _fetching = true;
    try {
      final r = await LibraryApi.list(app: widget.app, category: widget.category, folder: widget.folderId, cursor: _cursor);
      if (!mounted) return;
      setState(() {
        _items.addAll(r.items);
        _cursor = r.cursor;
        _more = r.cursor != null && r.items.isNotEmpty;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    } finally {
      _fetching = false;
    }
  }

  Future<void> _refresh() async {
    setState(() { _items.clear(); _cursor = null; _more = true; _loading = true; });
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final isGrid = widget.category == 'image' || widget.category == 'video';
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _items.isEmpty
              ? const Center(child: Text('Empty', style: TextStyle(color: AvaColors.sub)))
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: isGrid ? _grid() : _list(),
                ),
    );
  }

  Widget _grid() => GridView.builder(
        padding: const EdgeInsets.all(12),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3, crossAxisSpacing: 8, mainAxisSpacing: 8),
        itemCount: _items.length + (_more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= _items.length) { _load(); return const Center(child: CircularProgressIndicator()); }
          final m = _items[i];
          return GestureDetector(
            onTap: () => _open(m),
            onLongPress: () => _itemMenu(m),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: _thumb(m),
            ),
          );
        },
      );

  Widget _list() => ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _items.length + (_more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= _items.length) { _load(); return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())); }
          final m = _items[i];
          final c = _catOf(m.category);
          return Container(
            margin: const EdgeInsets.only(bottom: 8),
            decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
            child: ListTile(
              leading: Icon(c.icon, color: c.color),
              title: Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AvaColors.ink)),
              subtitle: Text('${_fmtBytes(m.size)}${m.sourceKind == 'received' ? ' · received' : ''}${m.isPrivate ? ' · private' : ''}',
                  style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
              trailing: IconButton(icon: const Icon(Icons.more_vert, color: AvaColors.sub), onPressed: () => _itemMenu(m)),
              onTap: () => _open(m),
            ),
          );
        },
      );

  Widget _thumb(LibraryItem m) {
    // Public images: Cloudflare AVIF thumbnail. Private/non-image: category tile.
    if (m.category == 'image' && !m.isPrivate && m.displayUrl.isNotEmpty) {
      return Image.network(AvatarCache.transformUrl(m.displayUrl, 240), fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _catTile(m));
    }
    return _catTile(m);
  }

  Widget _catTile(LibraryItem m) {
    final c = _catOf(m.category);
    return Container(
      color: c.color.withOpacity(0.12),
      child: Center(child: Icon(
        m.category == 'video' ? Icons.play_circle_outline : c.icon, color: c.color, size: 34)),
    );
  }

  Future<void> _open(LibraryItem m) async {
    if (!m.isPrivate && m.displayUrl.isNotEmpty) {
      final uri = Uri.parse(m.displayUrl);
      if (await canLaunchUrl(uri)) await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Private file — open it from the original chat')));
    }
  }

  Future<void> _itemMenu(LibraryItem m) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(leading: const Icon(Icons.drive_file_move_outline), title: const Text('Move to folder'), onTap: () => Navigator.pop(context, 'move')),
        ListTile(leading: const Icon(Icons.copy_all_outlined), title: const Text('Copy to folder'),
            subtitle: const Text("Shortcut — doesn't use extra storage"), onTap: () => Navigator.pop(context, 'copy')),
        if (m.isPrivate)
          ListTile(leading: const Icon(Icons.psychology_outlined, color: AvaColors.brand),
              title: const Text('Let AvaBrain read this'),
              subtitle: const Text('On-device only — nothing leaves your phone but a summary'),
              onTap: () => Navigator.pop(context, 'brain')),
        ListTile(leading: const Icon(Icons.delete_outline, color: AvaColors.danger),
            title: const Text('Delete', style: TextStyle(color: AvaColors.danger)), onTap: () => Navigator.pop(context, 'delete')),
      ])),
    );
    if (action == 'brain') {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Reading on-device…')));
      try {
        final msg = await PrivateIngest.ingest(m);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      } catch (_) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not read this file')));
      }
    } else if (action == 'delete') {
      await LibraryApi.delete(m.id);
      setState(() => _items.removeWhere((x) => x.id == m.id));
    } else if (action == 'move' || action == 'copy') {
      final dest = await _pickFolder();
      if (dest == _kCancel) return;
      if (action == 'move') {
        await LibraryApi.move(m.id, dest);
        if (widget.folderId != dest) setState(() => _items.removeWhere((x) => x.id == m.id));
      } else {
        await LibraryApi.copy(m.id, dest);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied (shortcut — counted once)')));
      }
    }
  }

  static const _kCancel = ' cancel';

  /// Returns folder id, null (= app root / system folder), or _kCancel.
  Future<String?> _pickFolder() async {
    return showModalBottomSheet<String?>(
      context: context,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Padding(padding: EdgeInsets.all(14), child: Text('Choose destination', style: TextStyle(fontWeight: FontWeight.w800))),
        ListTile(leading: const Icon(Icons.home_outlined), title: const Text('App root (its category)'), onTap: () => Navigator.pop(context, null)),
        for (final f in widget.folders)
          ListTile(leading: const Icon(Icons.folder, color: AvaColors.brand), title: Text(f.name), onTap: () => Navigator.pop(context, f.id)),
        const Divider(height: 1),
        ListTile(title: const Text('Cancel', style: TextStyle(color: AvaColors.sub)), onTap: () => Navigator.pop(context, _kCancel)),
      ])),
    );
  }
}

/// Shared little name prompt dialog.
Future<String?> _promptName(BuildContext context, String title, {String initial = ''}) {
  final ctrl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(hintText: 'Folder name')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Save')),
      ],
    ),
  );
}
