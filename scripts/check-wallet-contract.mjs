import { readFileSync } from "node:fs";

const screen = readFileSync("app/lib/features/wallet/wallet_screen.dart", "utf8");
const widgets = readFileSync("app/lib/features/wallet/wallet_widgets.dart", "utf8");
const statement = readFileSync("worker/src/routes/wallet_statement.ts", "utf8");

const failures = [];
const requireText = (source, needle, message) => {
  if (!source.includes(needle)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

requireText(screen, "WalletMoneyTilesRow(", "wallet screen must use the guarded Money In/Out row");
requireText(screen, "wallet_list_painted", "wallet must report loaded-vs-painted telemetry");
requireText(widgets, "return IntrinsicHeight(", "wallet Money In/Out row must establish finite height");
forbid(
  screen,
  /Row\(crossAxisAlignment:\s*CrossAxisAlignment\.stretch,\s*children:\s*\[\s*Expanded\(child:\s*_moneyTile/s,
  "wallet Money In/Out must never stretch directly inside the scrolling ListView",
);
requireText(statement, 'if (direction === "in") { where.push("amount > 0")', "Money In filter must remain sign-based");
requireText(statement, 'else if (direction === "out") { where.push("amount < 0")', "Money Out filter must remain sign-based");
requireText(statement, "AND amount<0", "wallet summaries/charts must count every signed debit type");
forbid(statement, /created_at>=\?2 AND type='spend' AND amount<0/, "wallet summaries must not hide new debit types");

if (failures.length) {
  for (const failure of failures) console.error(`WALLET CONTRACT: ${failure}`);
  process.exit(1);
}

console.log("Wallet contract OK: layout, telemetry, and sign-based accounting are protected.");
