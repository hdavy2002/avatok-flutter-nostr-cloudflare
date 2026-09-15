// Focused widget tests for the day editor and the interval/rule dialogs
// (review items 1, 2 and 7).
//
// These exercise real widget behaviour — a scope switch that LOADS the target
// schedule, a blocked save after a failed load, the explicit end-of-day
// control, and "Block time" opening in a blocked state — rather than asserting
// on label strings alone. No network is involved: the scope loader is injected.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/ui/zine_widgets.dart';
import 'package:avatok_call/features/calendar/calendar_data.dart';
import 'package:avatok_call/features/calendar/calendar_day_editor.dart';
import 'package:avatok_call/features/calendar/calendar_logic.dart';
import 'package:avatok_call/features/calendar/calendar_settings_screen.dart';

AvailabilityException _exception({
  required String id,
  required String date,
  required int startMin,
  required int endMin,
  AvailabilityExceptionStatus status = AvailabilityExceptionStatus.unavailable,
  String? listingId,
}) =>
    AvailabilityException(
      id: id,
      date: date,
      startMin: startMin,
      endMin: endMin,
      status: status,
      listingId: listingId,
    );

Future<void> _openSheet(
  WidgetTester tester, {
  required Future<CalendarDayEditResult?> Function(BuildContext context) open,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => open(context),
            child: const Text('open editor'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open editor'));
  await tester.pumpAndSettle();
}

void main() {
  final day = DateTime(2026, 9, 18);

  testWidgets('scope switch loads the target schedule before anything is saved',
      (tester) async {
    tester.view.physicalSize = const Size(1000, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final listingOnly = _exception(
      id: 'l1',
      date: '2026-09-18',
      startMin: 16 * 60,
      endMin: 17 * 60,
      status: AvailabilityExceptionStatus.unavailable,
    );
    final globalBreak = _exception(
      id: 'g1',
      date: '2026-09-18',
      startMin: 13 * 60,
      endMin: 14 * 60,
    );
    final otherDay = _exception(
      id: 'g2',
      date: '2026-09-19',
      startMin: 9 * 60,
      endMin: 10 * 60,
    );

    CalendarDayEditResult? result;
    var loads = 0;
    await _openSheet(
      tester,
      open: (context) async {
        result = await showCalendarDayEditor(
          context,
          day: day,
          timezone: 'UTC',
          exceptions: [listingOnly],
          listings: const [],
          selectedListingId: 'L1',
          horizonDays: 62,
          loadScope: (listingId) async {
            loads++;
            return listingId == null ? [globalBreak] : [listingOnly];
          },
        );
        return result;
      },
    );

    // The listing scope's own row is on screen first.
    expect(find.text('16:00\u201317:00'), findsOneWidget);

    // Switching scope fetches the TARGET's saved intervals...
    await tester.tap(find.text('All listings'));
    await tester.pumpAndSettle();
    expect(loads, 1);
    expect(find.text('13:00\u201314:00'), findsOneWidget);
    expect(find.text('16:00\u201317:00'), findsNothing);

    // ...and a block added now belongs to the global scope only.
    await tester.tap(find.widgetWithText(ZineButton, "I'm busy"));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ZineButton, 'Save changes'));
    await tester.pumpAndSettle();

    expect(result, isNotNull);
    expect(result!.scopeListingId, isNull);
    expect(result!.scopeLoaded, isTrue);
    expect(result!.delta.removedIds, isEmpty);
    expect(result!.delta.edited, isEmpty);
    expect(result!.delta.added.length, 1);
    expect(result!.delta.added.single.startMin, 9 * 60);
    expect(result!.delta.added.single.endMin, 17 * 60);

    // Applying the delta to the global schedule preserves ITS own intervals and
    // never copies the listing-only row across.
    final applied = applyDayEditDelta([globalBreak, otherDay], result!.delta);
    expect(applied.skippedIds, isEmpty);
    expect(applied.exceptions.any((e) => e.id == 'g1'), isTrue);
    expect(applied.exceptions.any((e) => e.id == 'g2'), isTrue);
    expect(applied.exceptions.where((e) => e.listingId == 'L1'), isEmpty);
  });

  testWidgets('a failed scope load keeps the old scope and blocks saving',
      (tester) async {
    tester.view.physicalSize = const Size(1000, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final listingOnly = _exception(
      id: 'l1',
      date: '2026-09-18',
      startMin: 16 * 60,
      endMin: 17 * 60,
    );
    await _openSheet(
      tester,
      open: (context) => showCalendarDayEditor(
        context,
        day: day,
        timezone: 'UTC',
        exceptions: [listingOnly],
        listings: const [],
        selectedListingId: 'L1',
        loadScope: (listingId) async => throw StateError('offline'),
      ),
    );

    await tester.tap(find.text('All listings'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Could not load that schedule'), findsOneWidget);
    // Still on the listing scope, and Save is disabled: a fetch failure can
    // never write one scope's rows into another.
    final chip = tester.widget<ZineChip>(
        find.widgetWithText(ZineChip, 'Only this listing'));
    expect(chip.active, isTrue);
    final save = tester.widget<ZineButton>(
        find.widgetWithText(ZineButton, 'Save changes'));
    expect(save.onPressed, isNull);
  });

  testWidgets('a partial 18:00\u201324:00 interval round-trips as 1440',
      (tester) async {
    final stored = _exception(
      id: 'e1',
      date: '2026-09-18',
      startMin: 18 * 60,
      endMin: 1440,
    );
    AvailabilityException? saved;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () async {
                saved = await showCalendarExceptionDialog(
                  context,
                  day: day,
                  defaultStatus: stored.status,
                  listings: const [],
                  initial: stored,
                  timezone: 'UTC',
                );
              },
              child: const Text('open dialog'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open dialog'));
    await tester.pumpAndSettle();

    // The stored end-of-day value is shown as such, not as midnight.
    expect(find.text('24:00 \u00b7 end of day'), findsOneWidget);
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(saved, isNotNull);
    expect(saved!.startMin, 18 * 60);
    expect(saved!.endMin, 1440);
    expect(saved!.isAllDay, isFalse);
  });

  testWidgets('All day and "ends at midnight" are independent choices',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showCalendarExceptionDialog(
                context,
                day: day,
                defaultStatus: AvailabilityExceptionStatus.unavailable,
                listings: const [],
                timezone: 'UTC',
              ),
              child: const Text('open dialog'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open dialog'));
    await tester.pumpAndSettle();

    expect(find.text('Ends at midnight'), findsOneWidget);
    // Turn All day ON: the clock range (and the end-of-day control) disappear.
    await tester.tap(find.byType(ZineToggle).first);
    await tester.pumpAndSettle();
    expect(find.text('Ends at midnight'), findsNothing);
    // Turn it back OFF: the end-of-day choice is still there and still off.
    await tester.tap(find.byType(ZineToggle).first);
    await tester.pumpAndSettle();
    expect(find.text('Ends at midnight'), findsOneWidget);
  });

  testWidgets('weekly working hours can end at midnight', (tester) async {
    AvailabilityRule? rule;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () async {
                rule = await showDialog<AvailabilityRule>(
                    context: context,
                    builder: (_) => const CalendarRuleDialog());
              },
              child: const Text('add hours'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('add hours'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Ends at midnight'));
    await tester.pumpAndSettle();
    expect(find.text('24:00 \u00b7 end of day'), findsOneWidget);

    await tester.tap(find.text('Add hours'));
    await tester.pumpAndSettle();
    expect(rule, isNotNull);
    expect(rule!.weekday, 1);
    expect(rule!.startMin, 9 * 60);
    expect(rule!.endMin, 1440);
  });

  testWidgets('Block time opens the interval dialog already blocked',
      (tester) async {
    await _openSheet(
      tester,
      open: (context) => showCalendarDayEditor(
        context,
        day: day,
        timezone: 'UTC',
        exceptions: const [],
        listings: const [],
        selectedListingId: null,
        startBlocked: true,
      ),
    );

    final chip = tester.widget<ZineChip>(
        find.widgetWithText(ZineChip, "I'm busy"));
    expect(chip.active, isTrue);
    expect(find.text('Save'), findsOneWidget);
  });

  testWidgets('an invalid policy number is explained inline before saving',
      (tester) async {
    int? saved;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showCalendarNumberDialog(
                context,
                title: 'Maximum per day',
                helper: 'How many appointments each day can hold.',
                initialValue: 0,
                validate: validateMaxPerDay,
                min: 1,
                max: 100,
                onSave: (value) => saved = value,
              ),
              child: const Text('open numbers'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open numbers'));
    await tester.pumpAndSettle();

    // 0 is refused with the supported range, and Save cannot be pressed.
    expect(find.text('Enter a number between 1 and 100.'), findsOneWidget);
    final disabled =
        tester.widget<ZineButton>(find.widgetWithText(ZineButton, 'Save'));
    expect(disabled.onPressed, isNull);
    expect(saved, isNull);

    await tester.enterText(find.byType(TextField).first, '8');
    await tester.pumpAndSettle();
    expect(find.text('Allowed: 1\u2013100.'), findsOneWidget);
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(saved, 8);
  });
}
