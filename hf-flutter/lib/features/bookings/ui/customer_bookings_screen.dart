import 'package:flutter/material.dart';
import 'booking_calendar_screen.dart';

class CustomerBookingsScreen extends StatelessWidget {
  const CustomerBookingsScreen({super.key});
  @override
  Widget build(BuildContext context) => const BookingCalendarScreen(role: 'customer');
}
