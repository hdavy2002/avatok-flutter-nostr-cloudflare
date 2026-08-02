import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/features/wallet/wallet_widgets.dart';

void main() {
  testWidgets('money tiles stay layout-safe inside the wallet ListView', (tester) async {
    const marker = Key('wallet-content-after-money-tiles');

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              SizedBox(height: 80),
              WalletMoneyTilesRow(
                moneyIn: SizedBox(height: 120, child: ColoredBox(color: Colors.green)),
                moneyOut: SizedBox(height: 80, child: ColoredBox(color: Colors.red)),
              ),
              SizedBox(key: marker, height: 40),
            ],
          ),
        ),
      ),
    );

    expect(tester.takeException(), isNull);
    expect(tester.getSize(find.byType(WalletMoneyTilesRow)).height, 120);
    expect(tester.getSize(find.byKey(marker)).height, 40);
  });
}
