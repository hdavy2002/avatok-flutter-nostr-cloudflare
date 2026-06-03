import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../core/avatar.dart';
import '../../core/config.dart';
import '../../core/theme.dart';
import 'live_screen.dart';

/// AvaLive landing — discover live streams and go live. Streams play in-app
/// (WHEP), never in a browser.
class AvaLiveDiscovery extends StatefulWidget {
  const AvaLiveDiscovery({super.key});
  @override
  State<AvaLiveDiscovery> createState() => _AvaLiveDiscoveryState();
}

class _AvaLiveDiscoveryState extends State<AvaLiveDiscovery> {
  List<Map<String, dynamic>> _streams = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final res = await http.get(Uri.parse(kLiveListUrl)).timeout(const Duration(seconds: 10));
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      _streams = ((j['streams'] as List?) ?? []).cast<Map<String, dynamic>>();
    } catch (_) {
      _streams = [];
    }
    if (mounted) setState(() => _loading = false);
  }

  void _watch(Map<String, dynamic> s) {
    Navigator.push(context, MaterialPageRoute(
        builder: (_) => LiveScreen(initialRoom: s['room'].toString(), autoWatch: true)));
  }

  void _goLive() {
    Navigator.push(context, MaterialPageRoute(builder: (_) => const LiveScreen()))
        .then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: Row(children: [
          Container(width: 26, height: 26,
              decoration: BoxDecoration(color: AvaColors.danger, borderRadius: BorderRadius.circular(8)),
              child: const Icon(Icons.sensors, color: Colors.white, size: 15)),
          const SizedBox(width: 8),
          const Text('AvaLive', style: TextStyle(fontWeight: FontWeight.w900)),
        ]),
        actions: [IconButton(onPressed: _load, icon: const Icon(Icons.refresh))],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AvaColors.danger,
        onPressed: _goLive,
        icon: const Icon(Icons.sensors, color: Colors.white),
        label: const Text('Go Live', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: AvaColors.brand))
            : _streams.isEmpty
                ? ListView(children: const [
                    SizedBox(height: 140),
                    Icon(Icons.sensors_off, size: 48, color: AvaColors.sub),
                    SizedBox(height: 12),
                    Center(child: Text('No live streams right now', style: TextStyle(color: AvaColors.sub))),
                    SizedBox(height: 4),
                    Center(child: Text('Tap “Go Live” to start one', style: TextStyle(color: AvaColors.sub, fontSize: 12.5))),
                  ])
                : ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _streams.length,
                    itemBuilder: (_, i) {
                      final s = _streams[i];
                      return GestureDetector(
                        onTap: () => _watch(s),
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 14),
                          decoration: BoxDecoration(
                              color: AvaColors.soft, borderRadius: BorderRadius.circular(18)),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            // thumbnail band with LIVE badge
                            Stack(children: [
                              Container(
                                height: 150,
                                decoration: BoxDecoration(
                                    gradient: const LinearGradient(
                                        colors: [Color(0xFF1FB6A6), Color(0xFF2E8BEE)],
                                        begin: Alignment.topLeft, end: Alignment.bottomRight),
                                    borderRadius: const BorderRadius.vertical(top: Radius.circular(18))),
                                child: const Center(child: Icon(Icons.play_circle_fill, color: Colors.white, size: 52)),
                              ),
                              Positioned(top: 10, left: 10, child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                decoration: BoxDecoration(color: AvaColors.danger, borderRadius: BorderRadius.circular(6)),
                                child: const Text('● LIVE', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 11)),
                              )),
                            ]),
                            Padding(
                              padding: const EdgeInsets.all(12),
                              child: Row(children: [
                                Avatar(seed: s['host']?.toString() ?? 'live', name: s['host']?.toString() ?? 'Creator', size: 38),
                                const SizedBox(width: 10),
                                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(s['title']?.toString() ?? 'Live stream',
                                      maxLines: 1, overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                                  Text(s['host']?.toString() ?? 'Creator',
                                      style: const TextStyle(color: AvaColors.sub, fontSize: 12.5)),
                                ])),
                                const Icon(Icons.visibility, color: AvaColors.brand),
                              ]),
                            ),
                          ]),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
