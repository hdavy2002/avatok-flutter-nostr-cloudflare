import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
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

final ImagePicker _imgPicker = ImagePicker();

/// Crude mime from a file name extension — the server re-derives the category,
/// this just gives it a good hint and keeps the Library entry tidy.
String _mimeFromName(String name, {String fallback = 'application/octet-stream'}) {
  final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  const m = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
    'webp': 'image/webp', 'heic': 'image/heic', 'bmp': 'image/bmp',
    'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm', 'mkv': 'video/x-matroska',
    'mp3': 'audio/mpeg', 'm4a': 'audio/aac', 'aac': 'audio/aac', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
    'pdf': 'application/pdf', 'txt': 'text/plain', 'csv': 'text/csv', 'md': 'text/markdown',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'zip': 'application/zip',
  };
  return m[ext] ?? fallback;
}

/// Destination apps for move/copy: everything that already has files in the
/// Library, plus AvaLibrary itself as a neutral home. Self-contained (reads the
/// cached tree) so any screen can offer "move anywhere".
Future<List<String>> _destApps() async {
  final t = await LibraryApi.cachedTree();
  final s = <String>{'avalibrary'};
  if (t != null) s.addAll(t.apps.map((a) => a.app));
  return s.toList();
}

/// A search box styled to the app. Calls [onChanged] live.
class _SearchBar extends StatelessWidget {
  final String hint;
  final ValueChanged<String> onChanged;
  const _SearchBar({required this.hint, required this.onChanged});
  @override
  Widget build(BuildContext context) => TextField(
        onChanged: onChanged,
        textInputAction: TextInputAction.search,
        decoration: InputDecoration(
          hintText: hint,
          prefixIcon: const Icon(Icons.search, color: AvaColors.sub),
          filled: true,
          fillColor: AvaColors.soft,
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
        ),
      );
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
  String _query = '';

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

  Future<void> _newFolder() async {
    final name = await _promptName(context, 'New folder');
    if (name == null || name.isEmpty) return;
    await LibraryApi.createFolder(app: 'avalibrary', name: name);
    _load();
  }

  Future<void> _add() async {
    // No folder context at the cross-app root → a new folder (and any uploads)
    // land in the AvaLibrary app itself.
    final did = await showAddSheet(context, app: 'avalibrary', folderId: null, onNewFolder: _newFolder);
    if (did) _load();
  }

  @override
  Widget build(BuildContext context) {
    final all = _tree?.apps ?? const <AppNode>[];
    final apps = _query.isEmpty
        ? all
        : all.where((a) => appByKey(a.app).name.toLowerCase().contains(_query.toLowerCase())).toList();
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('AvaLibrary', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AvaColors.brand,
        onPressed: _add,
        child: const Icon(Icons.add),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading && _tree == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(padding: const EdgeInsets.all(16), children: [
                _SearchBar(hint: 'Search apps', onChanged: (v) => setState(() => _query = v)),
                const SizedBox(height: 14),
                if (all.isEmpty)
                  _emptyBody()
                else ...[
                  const Text('Your files across every AvaVerse app.',
                      style: TextStyle(color: AvaColors.sub, fontSize: 13)),
                  const SizedBox(height: 14),
                  if (apps.isEmpty)
                    const Padding(padding: EdgeInsets.symmetric(vertical: 24),
                        child: Center(child: Text('No apps match.', style: TextStyle(color: AvaColors.sub))))
                  else
                    for (final a in apps) _appCard(a),
                ],
              ]),
      ),
    );
  }

  Widget _emptyBody() => const Padding(
        padding: EdgeInsets.only(top: 80),
        child: Column(children: [
          Icon(Icons.folder_open, size: 64, color: AvaColors.line),
          SizedBox(height: 12),
          Center(child: Text('No files yet', style: TextStyle(color: AvaColors.sub, fontWeight: FontWeight.w700))),
          SizedBox(height: 4),
          Center(child: Text('Tap + to upload, or send/receive a file in any app.',
              style: TextStyle(color: AvaColors.sub, fontSize: 12), textAlign: TextAlign.center)),
        ]),
      );

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
  late Map<String, int> _byCategory;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _folders = List.of(widget.tree.foldersByApp[widget.app] ?? const []);
    _byCategory = Map.of(widget.node.byCategory);
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final f = await LibraryApi.folders(widget.app);
      if (mounted) setState(() => _folders = f);
    } catch (_) {}
    try {
      final t = await LibraryApi.tree();
      final node = t.apps.where((a) => a.app == widget.app).cast<AppNode?>().firstWhere((_) => true, orElse: () => null);
      if (node != null && mounted) setState(() => _byCategory = Map.of(node.byCategory));
    } catch (_) {}
  }

  Future<void> _newFolder() async {
    final name = await _promptName(context, 'New folder');
    if (name == null || name.isEmpty) return;
    await LibraryApi.createFolder(app: widget.app, name: name);
    _refresh();
  }

  Future<void> _add() async {
    final did = await showAddSheet(context, app: widget.app, folderId: null, onNewFolder: _newFolder);
    if (did) _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final def = appByKey(widget.app);
    final q = _query.toLowerCase();
    final folders = q.isEmpty ? _folders : _folders.where((f) => f.name.toLowerCase().contains(q)).toList();
    final cats = q.isEmpty
        ? _cats
        : _cats.where((c) => c.label.toLowerCase().contains(q)).toList();
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(def.name, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.brand,
        onPressed: _add,
        icon: const Icon(Icons.add),
        label: const Text('Add'),
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        _SearchBar(hint: 'Search in ${def.name}', onChanged: (v) => setState(() => _query = v)),
        const SizedBox(height: 14),
        if (cats.any((c) => (_byCategory[c.key] ?? 0) > 0)) ...[
          const Text('CATEGORIES', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          for (final c in cats)
            if ((_byCategory[c.key] ?? 0) > 0) _row(
              icon: c.icon, color: c.color, title: c.label,
              sub: '${_byCategory[c.key]} item${_byCategory[c.key] == 1 ? '' : 's'}',
              onTap: () => _openView(category: c.key, title: c.label),
            ),
          const SizedBox(height: 18),
        ],
        Row(children: const [
          Text('FOLDERS', style: TextStyle(color: AvaColors.sub, fontSize: 11, letterSpacing: 1, fontWeight: FontWeight.w800)),
        ]),
        const SizedBox(height: 8),
        if (folders.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(_query.isEmpty ? 'No folders yet — tap Add › New folder.' : 'No folders match.',
                  style: const TextStyle(color: AvaColors.sub, fontSize: 12)))
        else
          for (final f in folders) _row(
            icon: Icons.folder, color: AvaColors.brand, title: f.name, sub: 'Folder',
            onTap: () => _openView(folder: f.id, title: f.name),
            menu: () => _folderMenu(f),
          ),
        const SizedBox(height: 80),
      ]),
    );
  }

  void _openView({String? category, String? folder, required String title}) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => _FolderView(app: widget.app, category: category, folderId: folder, title: title, folders: _folders),
    )).then((_) => _refresh());
  }

  Future<void> _folderMenu(LibraryFolder f) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Row(children: [const Icon(Icons.folder, color: AvaColors.brand), const SizedBox(width: 10),
              Expanded(child: Text(f.name, style: const TextStyle(fontWeight: FontWeight.w800)))])),
        const Divider(height: 1),
        ListTile(leading: const Icon(Icons.drive_file_rename_outline), title: const Text('Rename'), onTap: () => Navigator.pop(context, 'rename')),
        ListTile(leading: const Icon(Icons.drive_file_move_outline), title: const Text('Move to…'), onTap: () => Navigator.pop(context, 'move')),
        ListTile(leading: const Icon(Icons.copy_all_outlined), title: const Text('Copy to…'),
            subtitle: const Text('Duplicates the folder and its files (shortcuts)'), onTap: () => Navigator.pop(context, 'copy')),
        ListTile(leading: const Icon(Icons.delete_outline, color: AvaColors.danger),
            title: const Text('Delete folder', style: TextStyle(color: AvaColors.danger)),
            subtitle: const Text('Files move back to their category'), onTap: () => Navigator.pop(context, 'delete')),
      ])),
    );
    if (!mounted || action == null) return;
    if (action == 'rename') {
      final name = await _promptName(context, 'Rename folder', initial: f.name);
      if (name != null && name.isNotEmpty) { await LibraryApi.renameFolder(f.id, name); _refresh(); }
    } else if (action == 'delete') {
      await LibraryApi.deleteFolder(f.id);
      _refresh();
    } else if (action == 'move' || action == 'copy') {
      final dest = await _pickDestination(context, title: action == 'move' ? 'Move folder to' : 'Copy folder to', excludeFolderId: f.id);
      if (dest == null) return;
      if (action == 'move') {
        await LibraryApi.moveFolder(f.id, app: dest.app, parentId: dest.folder);
      } else {
        await LibraryApi.copyFolder(f.id, app: dest.app, parentId: dest.folder);
      }
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(action == 'move' ? 'Folder moved' : 'Folder copied')));
      _refresh();
    }
  }

  Widget _row({required IconData icon, required Color color, required String title, required String sub, required VoidCallback onTap, VoidCallback? menu}) =>
      Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
        child: ListTile(
          leading: Icon(icon, color: color),
          title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, color: AvaColors.ink)),
          subtitle: Text(sub, style: const TextStyle(color: AvaColors.sub, fontSize: 12)),
          trailing: menu == null
              ? const Icon(Icons.chevron_right, color: AvaColors.sub)
              : IconButton(icon: const Icon(Icons.more_vert, color: AvaColors.sub), onPressed: menu),
          onTap: onTap,
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
  String _query = '';
  String? _typeFilter;
  Timer? _searchDebounce;
  String _serverQ = ''; // the query the loaded pages were fetched with

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    super.dispose();
  }

  // Phase 4: search is SERVER-side (file_name LIKE over the whole index, user
  // folders included) — the instant client filter narrows the loaded pages while
  // the debounced refetch is in flight.
  void _onQuery(String v) {
    setState(() => _query = v);
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      if (!mounted || _serverQ == _query.trim()) return;
      _serverQ = _query.trim();
      if (_serverQ.isNotEmpty) Analytics.capture('library_search', {'q_len': _serverQ.length, 'app': widget.app});
      _refresh();
    });
  }

  Future<void> _load() async {
    if (_fetching) return; // guard against duplicate calls from the list sentinel
    _fetching = true;
    try {
      final r = await LibraryApi.list(
          app: widget.app, category: widget.category, folder: widget.folderId, cursor: _cursor,
          q: _serverQ.isEmpty ? null : _serverQ);
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

  Future<void> _add() async {
    // Inside a user folder → drop the upload right into it. In a category bucket
    // → app root (the server files it by detected type).
    final did = await showAddSheet(context, app: widget.app, folderId: widget.folderId);
    if (did) _refresh();
  }

  List<LibraryItem> get _visible {
    final q = _query.toLowerCase();
    return _items.where((m) {
      if (_typeFilter != null && m.category != _typeFilter) return false;
      if (q.isNotEmpty && !m.name.toLowerCase().contains(q)) return false;
      return true;
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final isGrid = widget.category == 'image' || widget.category == 'video';
    final isFolder = widget.folderId != null;
    final visible = _visible;
    final filtering = _query.isNotEmpty || _typeFilter != null;
    return Scaffold(
      backgroundColor: AvaColors.bg,
      appBar: AppBar(
        backgroundColor: AvaColors.bg, elevation: 0, foregroundColor: AvaColors.ink,
        title: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AvaColors.brand,
        onPressed: _add,
        child: const Icon(Icons.add),
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: _SearchBar(hint: 'Search files', onChanged: _onQuery),
        ),
        if (isFolder) _typeChips(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : visible.isEmpty
                  ? Center(child: Text(filtering ? 'No matches' : 'Empty', style: const TextStyle(color: AvaColors.sub)))
                  : RefreshIndicator(
                      onRefresh: _refresh,
                      child: isGrid ? _grid(visible, filtering) : _list(visible, filtering),
                    ),
        ),
      ]),
    );
  }

  Widget _typeChips() => SizedBox(
        height: 44,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
          _chip('All', null),
          for (final c in _cats) _chip(c.label, c.key),
        ]),
      );

  Widget _chip(String label, String? key) {
    final on = _typeFilter == key;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: on,
        onSelected: (_) => setState(() => _typeFilter = key),
        selectedColor: AvaColors.brand.withOpacity(0.18),
        labelStyle: TextStyle(color: on ? AvaColors.brand : AvaColors.sub, fontWeight: FontWeight.w700, fontSize: 12.5),
        backgroundColor: AvaColors.soft,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide.none),
      ),
    );
  }

  Widget _grid(List<LibraryItem> visible, bool filtering) => GridView.builder(
        padding: const EdgeInsets.all(12),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3, crossAxisSpacing: 8, mainAxisSpacing: 8),
        itemCount: visible.length + (!filtering && _more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= visible.length) { _load(); return const Center(child: CircularProgressIndicator()); }
          final m = visible[i];
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

  Widget _list(List<LibraryItem> visible, bool filtering) => ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: visible.length + (!filtering && _more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= visible.length) { _load(); return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())); }
          final m = visible[i];
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
        ListTile(leading: const Icon(Icons.drive_file_move_outline), title: const Text('Move to…'), onTap: () => Navigator.pop(context, 'move')),
        ListTile(leading: const Icon(Icons.copy_all_outlined), title: const Text('Copy to…'),
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
    if (!mounted || action == null) return;
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
      final dest = await _pickDestination(context, title: action == 'move' ? 'Move file to' : 'Copy file to');
      if (dest == null) return;
      if (action == 'move') {
        await LibraryApi.move(m.id, dest.folder, app: dest.app);
        // It left this view if it changed app or folder.
        if (dest.app != widget.app || widget.folderId != dest.folder) {
          setState(() => _items.removeWhere((x) => x.id == m.id));
        }
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Moved')));
      } else {
        await LibraryApi.copy(m.id, dest.folder, app: dest.app);
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied (shortcut — counted once)')));
      }
    }
  }
}

/// A destination chosen in the picker: an app + an optional folder (null = app root).
typedef _Dest = ({String app, String? folder});

/// Two-step destination picker covering the whole Library: pick an app, then a
/// folder within it (or its root). Returns null if cancelled. [excludeFolderId]
/// hides a folder (so you can't move/copy it into itself).
Future<_Dest?> _pickDestination(BuildContext context, {required String title, String? excludeFolderId}) async {
  final apps = await _destApps();
  if (!context.mounted) return null;
  final app = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(16), child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
      const Divider(height: 1),
      Flexible(child: ListView(shrinkWrap: true, children: [
        for (final a in apps)
          ListTile(
            leading: Icon(appByKey(a).icon, color: appByKey(a).color),
            title: Text(appByKey(a).name, style: const TextStyle(fontWeight: FontWeight.w700)),
            trailing: const Icon(Icons.chevron_right, color: AvaColors.sub),
            onTap: () => Navigator.pop(context, a),
          ),
      ])),
    ])),
  );
  if (app == null || !context.mounted) return null;

  List<LibraryFolder> folders = [];
  try { folders = await LibraryApi.folders(app); } catch (_) {}
  folders = folders.where((f) => f.id != excludeFolderId).toList();
  if (!context.mounted) return null;

  const kRoot = '__root__';
  final folder = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(16),
          child: Text('${appByKey(app).name} — choose folder', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
      const Divider(height: 1),
      Flexible(child: ListView(shrinkWrap: true, children: [
        ListTile(leading: const Icon(Icons.home_outlined), title: const Text('App root (its category)'), onTap: () => Navigator.pop(context, kRoot)),
        for (final f in folders)
          ListTile(leading: const Icon(Icons.folder, color: AvaColors.brand), title: Text(f.name), onTap: () => Navigator.pop(context, f.id)),
      ])),
    ])),
  );
  if (folder == null) return null;
  return (app: app, folder: folder == kRoot ? null : folder);
}

/// The "+" add sheet: optional New folder + upload paths (photo / camera / file).
/// Performs the chosen upload and returns true if anything was uploaded.
Future<bool> showAddSheet(BuildContext context, {required String app, String? folderId, Future<void> Function()? onNewFolder}) async {
  final action = await showModalBottomSheet<String>(
    context: context,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      const SizedBox(height: 6),
      if (onNewFolder != null)
        ListTile(leading: const Icon(Icons.create_new_folder_outlined, color: AvaColors.brand), title: const Text('New folder'), onTap: () => Navigator.pop(context, 'folder')),
      ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Upload photo'), onTap: () => Navigator.pop(context, 'photo')),
      ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take photo'), onTap: () => Navigator.pop(context, 'camera')),
      ListTile(leading: const Icon(Icons.upload_file_outlined), title: const Text('Upload file'), onTap: () => Navigator.pop(context, 'file')),
      const SizedBox(height: 6),
    ])),
  );
  if (action == null || !context.mounted) return false;
  if (action == 'folder') { await onNewFolder?.call(); return false; }

  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(const SnackBar(content: Text('Uploading…')));
  try {
    final n = await _pickAndUpload(action, app: app, folderId: folderId);
    if (n > 0) {
      messenger.showSnackBar(SnackBar(content: Text('Uploaded $n file${n == 1 ? '' : 's'}')));
      return true;
    }
    messenger.hideCurrentSnackBar();
    return false;
  } catch (_) {
    messenger.showSnackBar(const SnackBar(content: Text('Upload failed — please try again.')));
    return false;
  }
}

/// Picks media/files for the given source and uploads them. Returns the count
/// uploaded. Throws on hard failure.
Future<int> _pickAndUpload(String kind, {required String app, String? folderId}) async {
  if (kind == 'file') {
    final res = await FilePicker.platform.pickFiles(allowMultiple: true, withData: true);
    if (res == null || res.files.isEmpty) return 0;
    var n = 0;
    for (final f in res.files) {
      final bytes = f.bytes;
      if (bytes == null) continue;
      await LibraryApi.uploadFile(
        bytes: bytes, mime: _mimeFromName(f.name), name: f.name, app: app, folderId: folderId);
      n++;
    }
    return n;
  }
  final source = kind == 'camera' ? ImageSource.camera : ImageSource.gallery;
  final x = await _imgPicker.pickImage(source: source, maxWidth: 2400, imageQuality: 90);
  if (x == null) return 0;
  final bytes = await x.readAsBytes();
  final name = x.name.isNotEmpty ? x.name : 'photo_${DateTime.now().millisecondsSinceEpoch}.jpg';
  await LibraryApi.uploadFile(
    bytes: bytes, mime: _mimeFromName(name, fallback: 'image/jpeg'), name: name, app: app, folderId: folderId);
  return 1;
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
