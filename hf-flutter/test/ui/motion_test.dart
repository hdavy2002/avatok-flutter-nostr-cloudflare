import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/ui/motion.dart';

Widget host(Widget child, {bool reduced = false, bool ticking = true}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduced),
    child: HfMotionScope(child: TickerMode(enabled: ticking, child: Scaffold(body: child))),
  ),
);

double revealOffset(WidgetTester tester) {
  final transform = tester.widget<Transform>(find.descendant(
    of: find.byType(HfReveal), matching: find.byType(Transform)).first);
  return transform.transform.getTranslation().y;
}

void main() {
  testWidgets('runtime reduced motion completes an entrance and does not replay it', (tester) async {
    const child = HfReveal(child: Text('Ready'));
    await tester.pumpWidget(host(child));
    expect(revealOffset(tester), greaterThan(0));
    await tester.pumpWidget(host(child, reduced: true));
    expect(revealOffset(tester), 0);
    await tester.pumpWidget(host(child));
    expect(revealOffset(tester), 0);
    await tester.pumpWidget(const SizedBox.shrink());
    expect(tester.takeException(), isNull);
  });

  testWidgets('hidden motion completes without replaying on tab return', (tester) async {
    const child = HfReveal(child: Text('Status'));
    await tester.pumpWidget(host(child));
    await tester.pumpWidget(host(child, ticking: false));
    expect(revealOffset(tester), 0);
    await tester.pumpWidget(host(child));
    expect(revealOffset(tester), 0);
  });

  testWidgets('background settles motion and resume does not celebrate again', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(host(const HfReveal(child: Text('Confirmed'))));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(revealOffset(tester), 0);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(revealOffset(tester), 0);
  });

  testWidgets('stage cue retains text, focus, element and single tap action', (tester) async {
    final controller = TextEditingController(text: 'Existing name');
    final focus = FocusNode();
    var taps = 0;
    Widget stage(int value) => HfReveal(
      trigger: value,
      child: Column(children: [
        TextField(key: const Key('name'), controller: controller, focusNode: focus),
        HfPress(child: TextButton(onPressed: () => taps++, child: const Text('Continue'))),
      ]),
    );
    await tester.pumpWidget(host(stage(0)));
    await tester.pump(HfMotion.standard);
    focus.requestFocus();
    await tester.pump();
    final before = tester.element(find.byKey(const Key('name')));
    await tester.pumpWidget(host(stage(1)));
    expect(tester.element(find.byKey(const Key('name'))), same(before));
    expect(controller.text, 'Existing name');
    expect(focus.hasFocus, isTrue);
    await tester.tap(find.text('Continue'));
    await tester.pump(HfMotion.standard);
    expect(taps, 1);
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    focus.dispose();
    expect(tester.takeException(), isNull);
  });
  testWidgets('mid-selection preference change settles unchanged targets immediately', (tester) async {
    Widget controls(bool selected) => Column(children: [
      HfSelection(selected: selected, child: const Icon(Icons.person)),
      Builder(builder: (context) => HfAnimatedContainer(
        key: const Key('selection'),
        duration: HfMotion.duration(context),
        width: selected ? 100 : 50,
        height: 48,
        color: selected ? Colors.blue : Colors.red,
        child: const Text('Choice'),
      )),
    ]);
    await tester.pumpWidget(host(controls(false)));
    await tester.pumpWidget(host(controls(true)));
    await tester.pump(const Duration(milliseconds: 40));
    expect(tester.getSize(find.byKey(const Key('selection'))).width, lessThan(100));
    final before = tester.element(find.text('Choice'));
    await tester.pumpWidget(host(controls(true), reduced: true));
    expect(tester.getSize(find.byKey(const Key('selection'))).width, 100);
    expect(tester.element(find.text('Choice')), same(before));
    final transform = tester.widget<Transform>(find.descendant(
      of: find.byType(HfSelection), matching: find.byType(Transform)).first);
    expect(transform.transform.getTranslation().y, -2);
    await tester.pumpWidget(host(controls(true)));
    expect(tester.getSize(find.byKey(const Key('selection'))).width, 100);
  });

}
