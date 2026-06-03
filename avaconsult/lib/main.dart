import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'join.dart';

const kBrand = Color(0xFF7C5CFC); // AvaConsult accent (paid/pro)
const kInk = Color(0xFF0F1115);
const kSub = Color(0xFF737A86);
const kSoft = Color(0xFFF2F3F5);

/// Calls backend — mints RealtimeKit participant tokens (shared with AvaTok suite).
const String kJoinUrl = 'https://avatok-calls.getmystuffme.workers.dev/join';

void main() => runApp(const AvaConsultApp());

class AvaConsultApp extends StatelessWidget {
  const AvaConsultApp({super.key});
  @override
  Widget build(BuildContext context) {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: kBrand, primary: kBrand),
      scaffoldBackgroundColor: Colors.white,
    );
    return MaterialApp(
      title: 'AvaConsult',
      debugShowCheckedModeBanner: false,
      theme: base.copyWith(
        textTheme: GoogleFonts.nunitoTextTheme(base.textTheme),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: kBrand,
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(vertical: 16),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            textStyle: GoogleFonts.nunito(fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: kSoft,
          border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
        ),
      ),
      home: const ConsultHome(),
    );
  }
}

class ConsultHome extends StatelessWidget {
  const ConsultHome({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Spacer(flex: 2),
              Container(
                width: 72, height: 72,
                decoration: BoxDecoration(color: kBrand, borderRadius: BorderRadius.circular(20)),
                child: const Icon(Icons.groups, color: Colors.white, size: 38),
              ),
              const SizedBox(height: 24),
              Text('AvaConsult',
                  style: GoogleFonts.comfortaa(
                      fontSize: 36, fontWeight: FontWeight.w800, color: kInk)),
              const SizedBox(height: 8),
              const Text(
                'Paid group consultations — up to 20 people, HD video over Cloudflare RealtimeKit.',
                style: TextStyle(color: kSub, fontSize: 15, height: 1.5),
              ),
              const Spacer(flex: 3),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const JoinScreen(role: 'host'))),
                  icon: const Icon(Icons.video_call),
                  label: const Text('Start a consult'),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                      foregroundColor: kInk,
                      side: const BorderSide(color: Color(0xFFE0E2E6)),
                      padding: const EdgeInsets.symmetric(vertical: 16)),
                  onPressed: () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const JoinScreen(role: 'participant'))),
                  icon: const Icon(Icons.login),
                  label: const Text('Join a consult'),
                ),
              ),
              const SizedBox(height: 16),
              const Center(
                child: Text('Separate from AvaTok · powered by RealtimeKit SFU',
                    style: TextStyle(color: kSub, fontSize: 12)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
