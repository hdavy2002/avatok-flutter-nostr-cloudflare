import 'package:flutter/material.dart';
import 'booking_calendar_screen.dart';

class HostBookingsScreen extends StatelessWidget {
  const HostBookingsScreen({super.key});
  @override
  Widget build(BuildContext context) => const BookingCalendarScreen(role: 'host');
}
