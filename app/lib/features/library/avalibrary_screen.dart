import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/analytics.dart';
import '../../core/apps.dart';
import '../../core/library_api.dart';
import '../../core/ui/zine.dart';
import '../../core/ui/zine_widgets.dart';
import 'lib_thumbs.dart';
import 'private_ingest.dart';

/// Visual metadata for a system category folder.
class _Cat {
  final String key; // identity used in the UI + (mostly) the server category
  final String label;
  final IconData icon;
  final Color color;
  const _Cat(this.key, this.label, this.icon, this.color);
}

/// The cross-app file-type folders shown at the AvaLibrary root. PDFs are split
/// out from the rest of the document bucket ("Documents") so the root reads like
/// a clean file manager: Images, Videos, PDFs, Documents, Music, Other.
final _cats = <_Cat>[
  _Cat('image', 'Images', PhosphorIcons.image(PhosphorIconsStyle.bold), Zine.blue),
  _Cat('video', 'Videos', PhosphorIcons.filmStrip(PhosphorIconsStyle.bold), Zine.coral),
  _Cat('pdf', 'PDFs', PhosphorIcons.filePdf(PhosphorIconsStyle.bold), Zine.lime),
  _Cat('doc', 'Documents', PhosphorIcons.fileText(PhosphorIconsStyle.bold), Zine.lilac),
  _Cat('audio', 'Music', PhosphorIcons.musicNotes(PhosphorIconsStyle.bold), Zine.mint),
  _Cat('other', 'Other', PhosphorIcons.file(PhosphorIconsStyle.bold), Zine.blue),
];

_Cat _catOf(String k) => _cats.firstWhere((c) => c.key == k, orElse: () => _cats.last);

/// A visible root folder: its visual [cat], the live file [count], and the
/// [serverCat] passed to the list endpoint (lets us fold a legacy single
/// `document` bucket into "Documents" if the worker hasn't split pdf/doc yet).
typedef _RootFolder = ({_Cat cat, int count, String serverCat});

/// Aggregate per-category counts across every app root (AvaTOK + any others).
Map<String, int> _aggCounts(LibraryTree? t) {
  final c = <String, int>{};
  for (final a in t?.apps ?? const <AppNode>[]) {
    a.byCategory.forEach((k, v) => c[k] = (c[k] ?? 0) + v);
  }
  return c;
}

/// Build the root folder list from aggregated counts. Hides empty categories.
List<_RootFolder> _rootFolders(Map<String, int> counts) {
  // Legacy worker: a single 'document' bucket, not yet split into pdf/doc.
  final legacyDocs =
      !(counts.containsKey('pdf') || counts.containsKey('doc')) && (counts['document'] ?? 0) > 0;
  final out = <_RootFolder>[];
  for (final c in _cats) {
    if (c.key == 'pdf') {
      if (legacyDocs) continue; // folded into Documents below
      final n = counts['pdf'] ?? 0;
      if (n > 0) out.add((cat: c, count: n, serverCat: 'pdf'));
    } else if (c.key == 'doc') {
      if (legacyDocs) {
        out.add((cat: c, count: counts['document'] ?? 0, serverCat: 'document'));
      } else {
        final n = counts['doc'] ?? 0;
        if (n > 0) out.add((cat: c, count: n, serverCat: 'doc'));
      }
    } else {
      final n = counts[c.key] ?? 0;
      if (n > 0) out.add((cat: c, count: n, serverCat: c.key));
    }
  }
  return out;
}

const _months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/// "20 June 2026 (Saturday)", prefixed Today/Yesterday where it helps.
String _dayHeader(DateTime d) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final that = DateTime(d.year, d.month, d.day);
  final diff = today.difference(that).inDays;
  final base = '${d.day} ${_months[d.month - 1]} ${d.year} (${_weekdays[d.weekday - 1]})';
  if (diff == 0) return 'Today · $base';
  if (diff == 1) return 'Yesterday · $base';
  return base;
}

String _dayKey(DateTime d) => '${d.year}-${d.month}-${d.day}';

String _extOf(LibraryItem m) {
  final n = m.name;
  final i = n.lastIndexOf('.');
  if (i >= 0 && i < n.length - 1) return n.substring(i + 1).toUpperCase();
  return _catOf(m.category).label.toUpperCase();
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
/// Library, plus AvaLibrary itself as a neutral home.
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

/// Lime pill action button replacing the Material FAB (§7.1).
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

/// AvaLibrary — the global file manager. Root = cross-app file-TYPE folders
/// (Images / Videos / PDFs / Documents / Music / Other) + the user's folders.
/// Local-first: paints the cached tree, then refreshes.
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

  /// Every user folder across every app, flattened (AvaTOK is the only app today,
  /// but the model stays cross-app).
  List<LibraryFolder> get _allFolders {
    final out = <LibraryFolder>[];
    _tree?.foldersByApp.forEach((_, v) => out.addAll(v));
    return out;
  }

  Future<void> _newFolder() async {
    final name = await _promptName(context, 'New folder');
    if (name == null || name.isEmpty) return;
    await LibraryApi.createFolder(app: 'avalibrary', name: name);
    _load();
  }

  Future<void> _add() async {
    final did = await showAddSheet(context, app: 'avalibrary', folderId: null, onNewFolder: _newFolder);
    if (did) _load();
  }

  void _openCategory(_RootFolder f) {
    Analytics.capture('library_category_opened', {'category': f.serverCat, 'count': f.count});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => _FolderView(
        app: null, category: f.serverCat, folderId: null,
        title: f.cat.label),
    )).then((_) => _load());
  }

  void _openFolder(LibraryFolder f) {
    Analytics.capture('library_folder_opened', {'folder': f.id, 'app': f.app});
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => _FolderView(
        app: f.app, category: null, folderId: f.id,
        title: f.name),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final counts = _aggCounts(_tree);
    final q = _query.toLowerCase();
    final roots = _rootFolders(counts)
        .where((r) => q.isEmpty || r.cat.label.toLowerCase().contains(q))
        .toList();
    final folders = q.isEmpty
        ? _allFolders
        : _allFolders.where((f) => f.name.toLowerCase().contains(q)).toList();
    final empty = counts.values.fold<int>(0, (a, b) => a + b) == 0 && _allFolders.isEmpty;

    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: const ZineAppBar(
        title: 'AvaLibrary',
        markWord: 'Library',
        tag: 'Your files, every type',
      ),
      floatingActionButton: _ZineFab(onTap: _add, label: 'Add'),
      body: RefreshIndicator(
        color: Zine.blueInk,
        onRefresh: _load,
        child: _loading && _tree == null
            ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
            : ListView(padding: const EdgeInsets.all(18), children: [
                _SearchBar(hint: 'Search files & folders', onChanged: (v) => setState(() => _query = v)),
                const SizedBox(height: 14),
                if (empty)
                  _emptyBody()
                else ...[
                  Text('Your files across every AvaVerse app, by type.', style: ZineText.sub(size: 13.5)),
                  const SizedBox(height: 14),
                  if (roots.isNotEmpty) ...[
                    Text('LIBRARY', style: ZineText.kicker()),
                    const SizedBox(height: 10),
                    for (final r in roots) _row(
                      icon: r.cat.icon, color: r.cat.color, title: r.cat.label,
                      sub: '${r.count} file${r.count == 1 ? '' : 's'}',
                      onTap: () => _openCategory(r),
                    ),
                    const SizedBox(height: 18),
                  ],
                  Text('FOLDERS', style: ZineText.kicker()),
                  const SizedBox(height: 10),
                  if (folders.isEmpty)
                    Padding(padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Text(q.isEmpty ? 'No folders yet — tap Add › New folder.' : 'No folders match.',
                            style: ZineText.sub(size: 13)))
                  else
                    for (final f in folders) _row(
                      icon: PhosphorIcons.folder(PhosphorIconsStyle.bold), color: Zine.blue,
                      title: f.name, sub: 'Folder',
                      onTap: () => _openFolder(f),
                      menu: () => _folderMenu(f),
                    ),
                  const SizedBox(height: 90),
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
        _sheetTile(icon: PhosphorIcons.trash(PhosphorIconsStyle.bold), iconColor: Zine.coral,
            title: 'Delete folder', textColor: Zine.coral,
            subtitle: 'Files move back to their type folder',
            onTap: () => Navigator.pop(context, 'delete')),
        const SizedBox(height: 8),
      ])),
    );
    if (!mounted || action == null) return;
    if (action == 'rename') {
      final name = await _promptName(context, 'Rename folder', initial: f.name);
      if (name != null && name.isNotEmpty) { await LibraryApi.renameFolder(f.id, name); _load(); }
    } else if (action == 'delete') {
      await LibraryApi.deleteFolder(f.id);
      _load();
    }
  }
}

/// A file listing: a cross-app file-type bucket, or a user folder. Files are
/// shown newest-first, GROUPED UNDER DATE HEADERS, with a mini-calendar day
/// filter. Every file gets a real cached thumbnail tile (LibThumbs).
class _FolderView extends StatefulWidget {
  final String? app;        // null = across every app (a file-type view)
  final String? category;   // server category (image|video|pdf|doc|audio|other|document)
  final String? folderId;   // a user folder
  final String title;
  const _FolderView({
    required this.app, required this.category, required this.folderId,
    required this.title,
  });
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
  DateTime? _dayFilter;
  Timer? _searchDebounce;
  String _serverQ = '';

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

  // Server-side name search (file_name LIKE over the whole index); the instant
  // client filter narrows loaded pages while the debounced refetch is in flight.
  void _onQuery(String v) {
    setState(() => _query = v);
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), () {
      if (!mounted || _serverQ == _query.trim()) return;
      _serverQ = _query.trim();
      if (_serverQ.isNotEmpty) Analytics.capture('library_search', {'q_len': _serverQ.length, 'scope': widget.category ?? 'folder'});
      _refresh();
    });
  }

  Future<void> _load() async {
    if (_fetching) return;
    _fetching = true;
    final t0 = DateTime.now();
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
      Analytics.capture('library_list_loaded', {
        'scope': widget.category ?? (widget.folderId != null ? 'folder' : 'all'),
        'count': r.items.length,
        'latency_ms': DateTime.now().difference(t0).inMilliseconds,
      });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
      Analytics.error(domain: 'media', code: 'library_list_failed', message: e.toString(), screen: 'avalibrary');
    } finally {
      _fetching = false;
    }
  }

  Future<void> _refresh() async {
    setState(() { _items.clear(); _cursor = null; _more = true; _loading = true; });
    await _load();
  }

  // Keep paging until the chosen day is fully loaded (items are DESC by date, so
  // once the last loaded item is older than the day's start we have them all).
  Future<void> _ensureDayLoaded(DateTime day) async {
    final start = DateTime(day.year, day.month, day.day).millisecondsSinceEpoch;
    var guard = 0;
    while (_more && guard < 25) {
      if (_items.isNotEmpty && _items.last.createdAt < start) break;
      await _load();
      guard++;
    }
  }

  Future<void> _pickDay() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _dayFilter ?? now,
      firstDate: DateTime(2024, 1, 1),
      lastDate: now,
      builder: (ctx, child) => Theme(
        data: Theme.of(ctx).copyWith(
          colorScheme: ColorScheme.light(
            primary: Zine.blueInk, onPrimary: Colors.white, onSurface: Zine.ink),
        ),
        child: child!,
      ),
    );
    if (picked == null) return;
    setState(() => _dayFilter = picked);
    await _ensureDayLoaded(picked);
    if (!mounted) return;
    Analytics.capture('library_calendar_filter', {
      'day': _dayKey(picked),
      'results': _visible.length,
      'scope': widget.category ?? 'folder',
    });
    setState(() {});
  }

  Future<void> _add() async {
    final did = await showAddSheet(context, app: widget.app ?? 'avalibrary', folderId: widget.folderId);
    if (did) _refresh();
  }

  bool _matchesType(LibraryItem m, String key) {
    switch (key) {
      case 'pdf': return LibThumbs.isPdf(m);
      case 'doc': return m.category == 'document' && !LibThumbs.isPdf(m);
      default: return m.category == key;
    }
  }

  List<LibraryItem> get _visible {
    final q = _query.toLowerCase();
    return _items.where((m) {
      if (_typeFilter != null && !_matchesType(m, _typeFilter!)) return false;
      if (_dayFilter != null) {
        final d = DateTime.fromMillisecondsSinceEpoch(m.createdAt);
        if (d.year != _dayFilter!.year || d.month != _dayFilter!.month || d.day != _dayFilter!.day) {
          return false;
        }
      }
      if (q.isNotEmpty && !m.name.toLowerCase().contains(q)) return false;
      return true;
    }).toList();
  }

  bool get _filtering => _query.isNotEmpty || _typeFilter != null || _dayFilter != null;

  /// A flat, lazily-built render model: date headers interleaved with rows of up
  /// to three thumbnail tiles. Keeps infinite scroll cheap while giving sections.
  List<_Cell> _buildCells(List<LibraryItem> visible) {
    final cells = <_Cell>[];
    String? lastKey;
    var rowBuf = <LibraryItem>[];
    void flushRow() {
      if (rowBuf.isNotEmpty) { cells.add(_Cell.tiles(List.of(rowBuf))); rowBuf = []; }
    }
    for (final m in visible) {
      final d = DateTime.fromMillisecondsSinceEpoch(m.createdAt);
      final key = _dayKey(d);
      if (key != lastKey) {
        flushRow();
        cells.add(_Cell.header(_dayHeader(d)));
        lastKey = key;
      }
      rowBuf.add(m);
      if (rowBuf.length == 3) flushRow();
    }
    flushRow();
    return cells;
  }

  @override
  Widget build(BuildContext context) {
    final isFolder = widget.folderId != null;
    final visible = _visible;
    final cells = _buildCells(visible);
    final showSentinel = !_filtering && _more;

    return Scaffold(
      backgroundColor: Zine.paper,
      appBar: ZineAppBar(
        title: widget.title,
        tag: 'AvaLibrary / ${widget.title}',
        actions: [
          IconButton(
            tooltip: 'Pick a day',
            onPressed: _pickDay,
            icon: PhosphorIcon(PhosphorIcons.calendarDots(PhosphorIconsStyle.bold),
                size: 22, color: _dayFilter != null ? Zine.blueInk : Zine.ink),
          ),
        ],
      ),
      floatingActionButton: _ZineFab(onTap: _add),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 6),
          child: _SearchBar(hint: 'Search files', onChanged: _onQuery),
        ),
        if (_dayFilter != null) _dayChip(),
        if (isFolder) _typeChips(),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator(color: Zine.blueInk))
              : visible.isEmpty
                  ? Center(
                      child: ZineEmptyState(
                        icon: PhosphorIcons.fileDashed(PhosphorIconsStyle.bold),
                        text: _filtering ? 'No files match this filter.' : 'Nothing here yet — tap + to add.',
                      ),
                    )
                  : RefreshIndicator(
                      color: Zine.blueInk,
                      onRefresh: _refresh,
                      child: ListView.builder(
                        padding: const EdgeInsets.fromLTRB(14, 8, 14, 100),
                        itemCount: cells.length + (showSentinel ? 1 : 0),
                        itemBuilder: (_, i) {
                          if (i >= cells.length) {
                            _load();
                            return const Padding(padding: EdgeInsets.all(16),
                                child: Center(child: CircularProgressIndicator(color: Zine.blueInk)));
                          }
                          final c = cells[i];
                          if (c.header != null) {
                            return Padding(
                              padding: const EdgeInsets.fromLTRB(4, 16, 4, 8),
                              child: Text(c.header!.toUpperCase(), style: ZineText.kicker(size: 11)),
                            );
                          }
                          return _tileRow(c.tiles!);
                        },
                      ),
                    ),
        ),
      ]),
    );
  }

  Widget _dayChip() => Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 4),
        child: Row(children: [
          ZinePressable(
            onTap: () => setState(() => _dayFilter = null),
            color: Zine.lime,
            radius: BorderRadius.circular(100),
            boxShadow: Zine.shadowXs,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              PhosphorIcon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold), size: 15, color: Zine.ink),
              const SizedBox(width: 7),
              Text(_dayHeader(_dayFilter!), style: ZineText.tag(size: 11.5)),
              const SizedBox(width: 7),
              PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold), size: 13, color: Zine.ink),
            ]),
          ),
        ]),
      );

  Widget _typeChips() => SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.fromLTRB(18, 6, 18, 6), children: [
          _chip('All', null),
          for (final c in _cats) _chip(c.label, c.key),
        ]),
      );

  Widget _chip(String label, String? key) => Padding(
        padding: const EdgeInsets.only(right: 9),
        child: ZineChip(
          label: label.toUpperCase(),
          active: _typeFilter == key,
          onTap: () => setState(() => _typeFilter = key),
        ),
      );

  Widget _tileRow(List<LibraryItem> tiles) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: 10),
            Expanded(
              child: i < tiles.length
                  ? AspectRatio(aspectRatio: 1, child: _ThumbTile(
                      item: tiles[i], onTap: () => _open(tiles[i]), onMenu: () => _itemMenu(tiles[i])))
                  : const SizedBox.shrink(),
            ),
          ],
        ]),
      );

  Future<void> _open(LibraryItem m) async {
    if (!m.isPrivate && m.displayUrl.isNotEmpty) {
      final uri = Uri.parse(m.displayUrl);
      if (await canLaunchUrl(uri)) await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Private file — open it from the original chat')));
    }
  }

  Future<void> _itemMenu(LibraryItem m) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Zine.paper,
      shape: _sheetShape,
      builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.fromLTRB(18, 14, 18, 8),
            child: Row(children: [
              ZineIconBadge(icon: _catOf(m.category).icon, color: _catOf(m.category).color, size: 30),
              const SizedBox(width: 11),
              Expanded(child: Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: ZineText.cardTitle(size: 16))),
            ])),
        const Divider(height: 2, color: Zine.ink, thickness: 2),
        _sheetTile(icon: PhosphorIcons.arrowBendUpRight(PhosphorIconsStyle.bold), title: 'Move to…',
            onTap: () => Navigator.pop(context, 'move')),
        _sheetTile(icon: PhosphorIcons.copy(PhosphorIconsStyle.bold), title: 'Copy to…',
            subtitle: "Shortcut — doesn't use extra storage",
            onTap: () => Navigator.pop(context, 'copy')),
        if (m.isPrivate)
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

/// A header-or-tiles cell in the date-grouped render model.
class _Cell {
  final String? header;
  final List<LibraryItem>? tiles;
  const _Cell.header(this.header) : tiles = null;
  const _Cell.tiles(this.tiles) : header = null;
}

/// A single thumbnail tile. Loads a real cached preview (LibThumbs) and shows it;
/// while loading / on miss it shows a rich type tile (poster colour + glyph +
/// extension chip) so a tile is never blank.
class _ThumbTile extends StatefulWidget {
  final LibraryItem item;
  final VoidCallback onTap;
  final VoidCallback onMenu;
  const _ThumbTile({required this.item, required this.onTap, required this.onMenu});
  @override
  State<_ThumbTile> createState() => _ThumbTileState();
}

class _ThumbTileState extends State<_ThumbTile> {
  File? _file;
  bool _tried = false;

  @override
  void initState() {
    super.initState();
    _loadThumb();
  }

  @override
  void didUpdateWidget(_ThumbTile old) {
    super.didUpdateWidget(old);
    if (old.item.id != widget.item.id) { _file = null; _tried = false; _loadThumb(); }
  }

  Future<void> _loadThumb() async {
    if (!LibThumbs.canRender(widget.item)) { if (mounted) setState(() => _tried = true); return; }
    final f = await LibThumbs.thumb(widget.item);
    if (mounted) setState(() { _file = f; _tried = true; });
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.item;
    return GestureDetector(
      onTap: widget.onTap,
      onLongPress: widget.onMenu,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: Zine.paper2,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Zine.ink, width: 2),
        ),
        child: Stack(fit: StackFit.expand, children: [
          if (_file != null)
            Image.file(_file!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => _typeTile(m))
          else
            _typeTile(m),
          // Video glyph overlay on real frames.
          if (_file != null && LibThumbs.isVideo(m))
            const Center(child: Icon(Icons.play_circle_fill, color: Colors.white, size: 34)),
          // Loading shimmer-ish: nothing fancy, the type tile is the placeholder.
          // Bottom name/ext chip.
          Positioned(
            left: 0, right: 0, bottom: 0,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter, end: Alignment.topCenter,
                  colors: [Color(0xCC000000), Color(0x00000000)]),
              ),
              child: Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 10.5, fontWeight: FontWeight.w700)),
            ),
          ),
          if (!_tried && _file == null && LibThumbs.canRender(m))
            const Center(child: SizedBox(width: 20, height: 20,
                child: CircularProgressIndicator(strokeWidth: 2, color: Zine.blueInk))),
        ]),
      ),
    );
  }

  Widget _typeTile(LibraryItem m) {
    final c = _catOf(m.category);
    final isVid = LibThumbs.isVideo(m);
    return Container(
      color: c.color,
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        PhosphorIcon(
          isVid ? PhosphorIcons.playCircle(PhosphorIconsStyle.fill)
                : (LibThumbs.isPdf(m) ? PhosphorIcons.filePdf(PhosphorIconsStyle.bold) : c.icon),
          color: c.color == Zine.coral ? Colors.white : Zine.ink, size: 30),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
          decoration: BoxDecoration(
            color: Zine.paper,
            borderRadius: BorderRadius.circular(100),
            border: Border.all(color: Zine.ink, width: 1.5),
          ),
          child: Text(_extOf(m), style: ZineText.tag(size: 9)),
        ),
      ]),
    );
  }
}

/// A destination chosen in the picker: an app + an optional folder (null = root).
typedef _Dest = ({String app, String? folder});

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
          _sheetTile(icon: appByKey(a).icon, title: appByKey(a).name, onTap: () => Navigator.pop(context, a)),
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
        _sheetTile(icon: PhosphorIcons.house(PhosphorIconsStyle.bold), title: 'Library root (its type folder)',
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
      Analytics.capture('library_upload', {'count': n, 'source': action, 'app': app});
      return true;
    }
    messenger.hideCurrentSnackBar();
    return false;
  } catch (e) {
    messenger.showSnackBar(const SnackBar(content: Text('Upload failed — please try again.')));
    Analytics.error(domain: 'media', code: 'library_upload_failed', message: e.toString(), screen: 'avalibrary');
    return false;
  }
}

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
