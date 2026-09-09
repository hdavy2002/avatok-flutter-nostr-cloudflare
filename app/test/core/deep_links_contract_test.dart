import 'package:flutter_test/flutter_test.dart';

import 'package:avatok_call/core/deep_links.dart';

void main() {
  test('canonical live links retain the listing id', () {
    final destination = DeepLinks.parse(Uri.parse(
      'https://avatok.ai/live/listing-7',
    ));
    expect(destination?.kind, DeepLinkDestinationKind.liveEvent);
    expect(destination?.listingId, 'listing-7');
  });

  test('canonical session links retain the full booking id', () {
    final booking = 'commercial-booking-${'a' * 64}';
    final destination = DeepLinks.parse(Uri.parse(
      'https://avatok.ai/session/$booking',
    ));
    expect(destination?.kind, DeepLinkDestinationKind.commercialSession);
    expect(destination?.bookingId, booking);
  });

  test('legacy query and custom session links remain supported', () {
    final query = DeepLinks.parse(Uri.parse(
      'https://avatok.ai/session?listing_id=listing-1&booking_id=booking-1',
    ));
    expect(query?.listingId, 'listing-1');
    expect(query?.bookingId, 'booking-1');

    final custom = DeepLinks.parse(Uri.parse('avatok://booking/booking-2'));
    expect(custom?.bookingId, 'booking-2');
  });

  test('unrelated suffix hosts never receive app routes', () {
    final destination = DeepLinks.parse(Uri.parse(
      'https://evilavatok.ai/live/stolen-listing',
    ));
    expect(destination, isNull);
  });

  test('live root remains discovery while custom live ids stay exact', () {
    expect(
      DeepLinks.parse(Uri.parse('https://avatok.ai/live'))?.kind,
      DeepLinkDestinationKind.liveDiscovery,
    );
    expect(
      DeepLinks.parse(Uri.parse('avatok://live/listing-2'))?.listingId,
      'listing-2',
    );
  });
}
