import 'package:flutter/material.dart';
import '../../explore/ui/explore_screen.dart';

/// Marketplace is the home screen, including guest and deep-linked filters.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.query = const <String, String>{}});
  final Map<String, String> query;
  @override
  Widget build(BuildContext context) => ExploreScreen(query: query);
}
