import 'package:flutter/material.dart';

import '../../../core/widgets/widgets.dart';

/// Tab 2. Built in HF-NATIVE-3. Filters live in the route query: `/explore?lane=&topics=&lang=&max=&online=`.
class ExploreScreen extends StatelessWidget {
  const ExploreScreen({super.key, this.query = const <String, String>{}});

  /// The route's query parameters (lane, topics, lang, max, online).
  final Map<String, String> query;

  @override
  Widget build(BuildContext context) =>
      StubScreen(title: 'Explore', issue: 'HF-NATIVE-3', details: query);
}
