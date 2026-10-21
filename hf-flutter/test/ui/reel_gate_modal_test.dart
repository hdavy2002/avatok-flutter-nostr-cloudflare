import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/demo/reel_player.dart';

void main() {
  testWidgets(
    'calendar/info sheets and dialogs pause reels, then resume on pop',
    (tester) async {
      late BuildContext shell;
      await tester.pumpWidget(
        MaterialApp(
          navigatorObservers: [ReelGate.observer],
          home: Builder(
            builder: (context) {
              shell = context;
              return const Scaffold(body: Text('Reels'));
            },
          ),
        ),
      );
      await tester.pump();
      ReelGate.attachShell(ModalRoute.of(shell));
      ReelGate.setBranch(0);
      expect(ReelGate.visible.value, isTrue);
      showModalBottomSheet<void>(
        context: shell,
        builder: (_) => const SizedBox(height: 200, child: Text('Calendar')),
      );
      await tester.pumpAndSettle();
      expect(ReelGate.visible.value, isFalse);
      Navigator.of(shell).pop();
      await tester.pumpAndSettle();
      expect(ReelGate.visible.value, isTrue);
      showDialog<void>(
        context: shell,
        builder: (_) => const AlertDialog(content: Text('Info')),
      );
      await tester.pumpAndSettle();
      expect(ReelGate.visible.value, isFalse);
      Navigator.of(shell).pop();
      await tester.pumpAndSettle();
      expect(ReelGate.visible.value, isTrue);
      ReelGate.detachShell();
      await tester.pump();
    },
  );
}
