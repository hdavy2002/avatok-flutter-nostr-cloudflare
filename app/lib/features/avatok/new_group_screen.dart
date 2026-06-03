import 'package:flutter/material.dart';

import '../../core/avatar.dart';
import '../../core/theme.dart';
import 'chat_thread.dart';
import 'contacts.dart';
import 'data.dart';

/// Create a group: name it, pick members from contacts. Chat-only — AvaTok has
/// no group video calls (those live in AvaConsult).
class NewGroupScreen extends StatefulWidget {
  final List<Contact> contacts;
  const NewGroupScreen({super.key, required this.contacts});
  @override
  State<NewGroupScreen> createState() => _NewGroupScreenState();
}

class _NewGroupScreenState extends State<NewGroupScreen> {
  final _name = TextEditingController();
  final Set<String> _picked = {};

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  bool get _canCreate => _name.text.trim().isNotEmpty && _picked.isNotEmpty;

  void _create() {
    final group = Chat(
      name: _name.text.trim(),
      seed: 'group-${_name.text.trim()}',
      last: 'Group created · ${_picked.length} members',
      time: 'now',
      group: true,
    );
    Navigator.pushReplacement(context,
        MaterialPageRoute(builder: (_) => ChatThreadScreen(chat: group)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white, elevation: 0, foregroundColor: AvaColors.ink,
        title: const Text('New group'),
        actions: [
          TextButton(
            onPressed: _canCreate ? _create : null,
            child: Text('Create',
                style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: _canCreate ? AvaColors.brand : const Color(0xFFBFC4CC))),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                  color: AvaColors.soft, borderRadius: BorderRadius.circular(14)),
              child: TextField(
                controller: _name,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                    hintText: 'Group name', border: InputBorder.none,
                    icon: Icon(Icons.groups_outlined, color: AvaColors.sub)),
              ),
            ),
          ),
          const Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: EdgeInsets.fromLTRB(20, 8, 20, 4),
              child: Text('ADD MEMBERS',
                  style: TextStyle(color: AvaColors.sub, fontSize: 11,
                      letterSpacing: 1, fontWeight: FontWeight.w700)),
            ),
          ),
          Expanded(
            child: widget.contacts.isEmpty
                ? const Center(
                    child: Text('Add contacts first to build a group',
                        style: TextStyle(color: AvaColors.sub)))
                : ListView.builder(
                    itemCount: widget.contacts.length,
                    itemBuilder: (_, i) {
                      final c = widget.contacts[i];
                      final on = _picked.contains(c.npub);
                      return CheckboxListTile(
                        value: on,
                        activeColor: AvaColors.brand,
                        controlAffinity: ListTileControlAffinity.trailing,
                        onChanged: (v) => setState(() =>
                            v == true ? _picked.add(c.npub) : _picked.remove(c.npub)),
                        secondary: Avatar(seed: c.seed, name: c.name, size: 42),
                        title: Text(c.name,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: c.handle.isNotEmpty
                            ? Text(c.atHandle, style: const TextStyle(color: AvaColors.sub))
                            : null,
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
