import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/avatar_cache.dart';
import '../../core/apps.dart';
import '../../core/library_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'private_ingest.dart';

/// Visual metadata for the five system categories.
class _Cat {
  final String key;
  final String label;
  final IconData icon;
  final Color color;
  const _Cat(this.key, this.label, this.icon, this.color);
}

final _cats = <_Cat>[
  _Cat('image', 'Images', PhosphorIcons.image(PhosphorIconsStyle.bold), Zine.blue),
  _Cat('video', 'Videos', PhosphorIcons.filmStrip(PhosphorIconsStyle.bold), Zine.coral),
  _Cat('document', 'Documents', PhosphorIcons.fileText(PhosphorIconsStyle.bold), Zine.lime),
  _Cat('audio', 'Music', PhosphorIcons.musicNotes(PhosphorIconsStyle.bold), Zine.lilac),
  _Cat('other', 'Other', PhosphorIcons.file(PhosphorIconsStyle.bold), Zine.mint),
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

/// A search box in the zine field chrome (§7.2). Calls [onChanged] live.
class _SearchBar extends StatelessWidget {
  final String hint;
  final ValueChanged<String> onChanged;
  const _SearchBar({required this.hint, required this.onChanged});
  @override
  Widget build(BuildContext context) => ZineField(
        hint: hint,
        leadIcon: PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
        onChanged: onChanged,
      );
}

/// Lime pill action button replacing the Material FAB (§7.1) — the ONE lime
/// primary on each Library screen.
class _ZineFab extends StatelessWidget {
  final VoidCallback onTap;
  final String? label;
  const _ZineFab({required this.onTap, this.label});
  @override
  Widget build(BuildContext context) => ZinePressable(
        onTap: onTap,
        color: Zine.lime,
        radius: BorderRadius.circular(100),
        padding: EdgeInsets.symmetric(horizontal: label == null ? 16 : 20, vertical: 15),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.plus(PhosphorIconsStyle.bold), size: 20, color: Zine.ink),
          if (label != null) ...[
            const SizedBox(width: 8),
            Text(label!, style: ZineText.button(size: 17)),
          ],
        ]),
      );
}

/// Bottom-sheet row in the zine voice: phosphor icon + Nunito label.
Widget _sheetTile({
  required IconData icon,
  required String title,
  String? subtitle,
  Color iconColor = Zine.ink,
  Color? textColor,
  required VoidCallback onTap,
}) =>
    InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
        child: Row(children: [
          PhosphorIcon(icon, size: 21, color: iconColor),
          const SizedBox(width: 13),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: ZineText.value(size: 15, color: textColor ?? Zine.ink, weight: FontWeight.w700)),
              if (subtitle != null) ...[
                const SizedBox(height: 1),
                Text(subtitle, style: ZineText.sub(size: 12.5)),
              ],
            ]),
          ),
        ]),
      ),
    );

/// Shared zine bottom-sheet chrome: paper fill, ink top border.
const _sheetShape = RoundedRectangleBorder(
  borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
  side: BorderSide(color: Zine.ink, width: Zine.bw),
);

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
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'AvaLibrary',
        markWord: 'Library',
        tag: 'Your files, every app',
      ),
      floatingActionButton: _ZineFab(onTap: _add),
      body: RefreshIndicator(
        color: Zine.blueInk,
        onRefresh: _load,
        child: _loading && _tree == null
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : ListView(padding: const EdgeInsets.all(18), children: [
                _SearchBar(hint: 'Search apps', onChanged: (v) => setState(() => _query = v)),
                const SizedBox(height: 14),
                if (all.isEmpty)
                  _emptyBody()
                else ...[
                  Text('Your files across every AvaVerse app.', style: ZineText.sub(size: 13.5)),
                  const SizedBox(height: 14),
                  if (apps.isEmpty)
                    Padding(padding: const EdgeInsets.symmetric(vertical: 24),
                        child: Center(child: Text('No apps match.', style: ZineText.sub(size: 14))))
                  else
                    for (final (i, a) in apps.indexed) _appCard(a, i),
                ],
              ]),
      ),
    );
  }

  Widget _emptyBody() => Padding(
        padding: const EdgeInsets.only(top: 80),
        child: Center(
          child: ZineEmptyState(
            icon: PhosphorIcons.folderOpen(PhosphorIconsStyle.bold),
            text: 'No files yet — tap + to upload, or send a file in any app.',
          ),
        ),
      );

  Widget _appCard(AppNode a, int i) {
    final def = appByKey(a.app);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ZineCard(
        radius: Zine.rSm,
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
        onTap: () => Navigator.push(context, MaterialPageRoute(
            builder: (_) => _AppView(app: a.app, node: a, tree: _tree!))).then((_) => _load()),
        child: Row(children: [
          // Accent badges rotate (§6) so adjacent app cards differ.
          ZineIconBadge(icon: def.icon, color: Zine.accents[i % Zine.accents.length], size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(def.name, style: ZineText.value(size: 15.5)),
              const SizedBox(height: 2),
              Text('${a.total} file${a.total == 1 ? '' : 's'} · ${_fmtBytes(a.bytes)}'.toUpperCase(),
                  style: ZineText.kicker(size: 10)),
            ]),
          ),
          PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft),
        ]),
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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: def.name,
        tag: 'AvaLibrary / ${def.name}', // breadcrumb, mono (§3)
      ),
      floatingActionButton: _ZineFab(onTap: _add, label: 'Add'),
      body: ListView(padding: const EdgeInsets.all(18), children: [
        _SearchBar(hint: 'Search in ${def.name}', onChanged: (v) => setState(() => _query = v)),
        const SizedBox(height: 16),
        if (cats.any((c) => (_byCategory[c.key] ?? 0) > 0)) ...[
          Text('CATEGORIES', style: ZineText.kicker()),
          const SizedBox(height: 10),
          for (final c in cats)
            if ((_byCategory[c.key] ?? 0) > 0) _row(
              icon: c.icon, color: c.color, title: c.label,
              sub: '${_byCategory[c.key]} item${_byCategory[c.key] == 1 ? '' : 's'}',
              onTap: () => _openView(category: c.key, title: c.label),
            ),
          const SizedBox(height: 18),
        ],
        Text('FOLDERS', style: ZineText.kicker()),
        const SizedBox(height: 10),
        if (folders.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(_query.isEmpty ? 'No folders yet — tap Add › New folder.' : 'No folders match.',
                  style: ZineText.sub(size: 13)))
        else
          for (final f in folders) _row(
            icon: PhosphorIcons.folder(PhosphorIconsStyle.bold), color: Zine.blue,
            title: f.name, sub: 'Folder',
            onTap: () => _openView(folder: f.id, title: f.name),
            menu: () => _folderMenu(f),
          ),
        const SizedBox(height: 90),
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
      backgroundColor: Zine.paper,
      shape: _sheetShape,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
            child: Row(children: [
              ZineIconBadge(icon: PhosphorIcons.folder(PhosphorIconsStyle.bold), color: Zine.blue, size: 30),
              const SizedBox(width: 11),
              Expanded(child: Text(f.name, style: ZineText.cardTitle(size: 17))),
            ])),
        const Divider(height: 2, color: Zine.ink, thickness: 2),
        _sheetTile(icon: PhosphorIcons.pencilSimple(PhosphorIconsStyle.bold), title: 'Rename',
            onTap: () => Navigator.pop(context, 'rename')),
        _sheetTile(icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), title: 'Move to…',
            onTap: () => Navigator.pop(context, 'move')),
        _sheetTile(icon: PhosphorIcons.copy(PhosphorIconsStyle.bold), title: 'Copy to…',
            subtitle: 'Duplicates the folder and its files (shortcuts)',
            onTap: () => Navigator.pop(context, 'copy')),
        _sheetTile(icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), iconColor: Zine.coral,
            title: 'Delete folder', textColor: Zine.coral,
            subtitle: 'Files move back to their category',
            onTap: () => Navigator.pop(context, 'delete')),
        const SizedBox(height: 8),
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
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: ZineCard(
          radius: 14,
          padding: const EdgeInsets.fromLTRB(13, 11, 9, 11),
          onTap: onTap,
          child: Row(children: [
            ZineIconBadge(icon: icon, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 15)),
                const SizedBox(height: 2),
                Text(sub.toUpperCase(), style: ZineText.kicker(size: 10)),
              ]),
            ),
            if (menu == null)
              PhosphorIcon(PhosphorIcons.caretRight(PhosphorIconsStyle.bold), size: 16, color: Zine.inkSoft)
            else
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: menu,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                      size: 20, color: Zine.inkSoft),
                ),
              ),
          ]),
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
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.title,
        tag: '${appByKey(widget.app).name} / ${widget.title}', // breadcrumb, mono
      ),
      floatingActionButton: _ZineFab(onTap: _add),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 6),
          child: _SearchBar(hint: 'Search files', onChanged: _onQuery),
        ),
        if (isFolder) _typeChips(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : visible.isEmpty
                  ? Center(
                      child: ZineEmptyState(
                        icon: PhosphorIcons.fileDashed(PhosphorIconsStyle.bold),
                        text: filtering ? 'No matches — try another search.' : 'Nothing here yet — tap + to add.',
                      ),
                    )
                  : RefreshIndicator(
                      color: Zine.blueInk,
                      onRefresh: _refresh,
                      child: isGrid ? _grid(visible, filtering) : _list(visible, filtering),
                    ),
        ),
      ]),
    );
  }

  Widget _typeChips() => SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(18, 6, 18, 6), children: [
          _chip('All', null),
          for (final c in _cats) _chip(c.label, c.key),
        ]),
      );

  // Filter chip (§7.4): active = lime fill + check + shadow.
  Widget _chip(String label, String? key) => Padding(
        padding: const EdgeInsets.only(right: 9),
        child: ZineChip(
          label: label.toUpperCase(),
          active: _typeFilter == key,
          onTap: () => setState(() => _typeFilter = key),
        ),
      );

  Widget _grid(List<LibraryItem> visible, bool filtering) => GridView.builder(
        padding: const EdgeInsets.all(14),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3, crossAxisSpacing: 10, mainAxisSpacing: 10),
        itemCount: visible.length + (!filtering && _more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= visible.length) { _load(); return const Center(child: CircularProgressIndicator(color: Zine.blueInk)); }
          final m = visible[i];
          return GestureDetector(
            onTap: () => _open(m),
            onLongPress: () => _itemMenu(m),
            // Grid tile: ink border + radius 14 (tiles range per §4).
            child: Container(
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: Zine.paper2,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Zine.ink, width: 2),
              ),
              child: _thumb(m),
            ),
          );
        },
      );

  Widget _list(List<LibraryItem> visible, bool filtering) => ListView.builder(
        padding: const EdgeInsets.all(14),
        itemCount: visible.length + (!filtering && _more ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= visible.length) { _load(); return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(color: Zine.blueInk))); }
          final m = visible[i];
          final c = _catOf(m.category);
          return Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: ZineCard(
              radius: 14,
              padding: const EdgeInsets.fromLTRB(13, 11, 9, 11),
              onTap: () => _open(m),
              child: Row(children: [
                ZineIconBadge(icon: c.icon, color: c.color),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ZineText.value(size: 14.5)),
                    const SizedBox(height: 2),
                    Text('${_fmtBytes(m.size)}${m.sourceKind == 'received' ? ' · received' : ''}${m.isPrivate ? ' · private' : ''}'.toUpperCase(),
                        style: ZineText.kicker(size: 10)),
                  ]),
                ),
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => _itemMenu(m),
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: PhosphorIcon(PhosphorIcons.dotsThreeVertical(PhosphorIconsStyle.bold),
                        size: 20, color: Zine.inkSoft),
                  ),
                ),
              ]),
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

  // Flat accent tile (no alpha washes): poster fill + ink icon.
  Widget _catTile(LibraryItem m) {
    final c = _catOf(m.category);
    return Container(
      color: c.color,
      child: Center(child: PhosphorIcon(
        m.category == 'video' ? PhosphorIcons.playCircle(PhosphorIconsStyle.fill) : c.icon,
        color: c.color == Zine.coral ? Colors.white : Zine.ink, size: 32)),
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
      backgroundColor: Zine.paper,
      shape: _sheetShape,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(height: 10),
        _sheetTile(icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), title: 'Move to…',
            onTap: () => Navigator.pop(context, 'move')),
        _sheetTile(icon: PhosphorIcons.copy(PhosphorIconsStyle.bold), title: 'Copy to…',
            subtitle: "Shortcut — doesn't use extra storage",
            onTap: () => Navigator.pop(context, 'copy')),
        if (m.isPrivate)
          // AI action → lilac (§2).
          _sheetTile(icon: PhosphorIcons.brain(PhosphorIconsStyle.bold), iconColor: Zine.lilac,
              title: 'Let AvaBrain read this',
              subtitle: 'On-device only — nothing leaves your phone but a summary',
              onTap: () => Navigator.pop(context, 'brain')),
        _sheetTile(icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), iconColor: Zine.coral,
            title: 'Delete', textColor: Zine.coral,
            onTap: () => Navigator.pop(context, 'delete')),
        const SizedBox(height: 8),
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
    backgroundColor: Zine.paper,
    shape: _sheetShape,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(18), child: Text(title, style: ZineText.cardTitle(size: 17))),
      const Divider(height: 2, color: Zine.ink, thickness: 2),
      Flexible(child: ListView(shrinkWrap: true, children: [
        for (final a in apps)
          _sheetTile(
            icon: appByKey(a).icon,
            title: appByKey(a).name,
            onTap: () => Navigator.pop(context, a),
          ),
        const SizedBox(height: 8),
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
    backgroundColor: Zine.paper,
    shape: _sheetShape,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(18),
          child: Text('${appByKey(app).name} — choose folder', style: ZineText.cardTitle(size: 17))),
      const Divider(height: 2, color: Zine.ink, thickness: 2),
      Flexible(child: ListView(shrinkWrap: true, children: [
        _sheetTile(icon: PhosphorIcons.house(PhosphorIconsStyle.bold), title: 'App root (its category)',
            onTap: () => Navigator.pop(context, kRoot)),
        for (final f in folders)
          _sheetTile(icon: PhosphorIcons.folder(PhosphorIconsStyle.bold), iconColor: Zine.blueInk,
              title: f.name, onTap: () => Navigator.pop(context, f.id)),
        const SizedBox(height: 8),
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
    backgroundColor: Zine.paper,
    shape: _sheetShape,
    builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      const SizedBox(height: 10),
      if (onNewFolder != null)
        _sheetTile(icon: PhosphorIcons.folderPlus(PhosphorIconsStyle.bold), iconColor: Zine.blueInk,
            title: 'New folder', onTap: () => Navigator.pop(context, 'folder')),
      _sheetTile(icon: PhosphorIcons.images(PhosphorIconsStyle.bold), title: 'Upload photo',
          onTap: () => Navigator.pop(context, 'photo')),
      _sheetTile(icon: PhosphorIcons.camera(PhosphorIconsStyle.bold), title: 'Take photo',
          onTap: () => Navigator.pop(context, 'camera')),
      _sheetTile(icon: PhosphorIcons.uploadSimple(PhosphorIconsStyle.bold), title: 'Upload file',
          onTap: () => Navigator.pop(context, 'file')),
      const SizedBox(height: 10),
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
      backgroundColor: Zine.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Zine.r),
        side: const BorderSide(color: Zine.ink, width: Zine.bw),
      ),
      title: Text(title, style: ZineText.cardTitle(size: 17)),
      content: ZineField(controller: ctrl, autofocus: true, hint: 'Folder name'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: Text('Cancel', style: ZineText.link())),
        ZineButton(
          label: 'Save it',
          variant: ZineButtonVariant.blue,
          fontSize: 15,
          onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
        ),
      ],
    ),
  );
}
