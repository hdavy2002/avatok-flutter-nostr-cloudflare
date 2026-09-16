
import 'ui_text.dart';
import 'package:flutter/material.dart';
import 'ui_locale_controller.dart';
import 'ui_locales.dart';

/// Scrollable, unconstrained-height language choices remain usable with large
/// accessibility text on small devices. Unsupported catalogs stay visibly gated.
class UiLanguageTile extends StatelessWidget {
  const UiLanguageTile({super.key});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: UiLocaleController.instance,
    builder: (context, _) {
      final controller = UiLocaleController.instance;
      return ListTile(
        leading: const Icon(Icons.language),
        title: const UiText(UiMessage.m_app_language_b8352b44a5),
        subtitle: Text(controller.selected.nativeName),
        trailing: controller.loading
            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator())
            : const Icon(Icons.chevron_right),
        onTap: () => showModalBottomSheet<void>(
          context: context, isScrollControlled: true, useSafeArea: true,
          builder: (context) => FractionallySizedBox(heightFactor: .8,
            child: ListenableBuilder(listenable: controller, builder: (context, _) =>
              Column(children: [
                const Padding(padding: EdgeInsets.all(16),
                  child: UiText(UiMessage.m_app_language_b8352b44a5, style: TextStyle(fontSize: 20))),
                if (controller.fallback || !controller.frameworkSupported)
                  const Padding(padding: EdgeInsets.symmetric(horizontal: 16),
                    child: UiText(UiMessage.m_some_interface_text_is_shown_2fc750d6df)),
                Expanded(child: ListView(
                  children: [
                    for (final choice in uiLocales)
                      ListTile(
                        title: Text(choice.nativeName,
                          textDirection: choice.rtl ? TextDirection.rtl : TextDirection.ltr),
                        subtitle: controller.available(choice.code)
                            ? null : const UiText(UiMessage.m_translation_not_published_yet_c145f1c572),
                        enabled: !controller.loading && controller.available(choice.code),
                        trailing: controller.selected.code == choice.code
                            ? const Icon(Icons.check) : null,
                        onTap: () async {
                          final ok = await controller.setLocale(choice.code);
                          if (!context.mounted) return;
                          if (ok) Navigator.pop(context);
                        },
                      ),
                  ],
                )),
              ]),
            ),
          ),
        ),
      );
    },
  );
}
