import '../../core/commercial_sessions_api.dart';
import 'commercial_getstream_handoff.dart';

/// Bridges the existing GetStream entry screen to authenticated commercial
/// join endpoints. Provider identity and call IDs remain server supplied.
class ServerCommercialGetStreamGateway implements CommercialGetStreamJoinGateway {
  const ServerCommercialGetStreamGateway();

  @override
  Future<CommercialGetStreamJoinHandoff> authorize(
    CommercialGetStreamJoinRequest request,
  ) async {
    final raw = request.product == CommercialGetStreamProduct.liveEvent
        ? await CommercialSessionsApi.liveJoin(request.listingId)
        : request.bookingId == null
            ? null
            : await CommercialSessionsApi.consultJoin(request.bookingId!);
    if (raw == null) throw StateError('This session is not available right now.');
    return CommercialGetStreamJoinHandoff.fromServer(
      raw,
      expectedProduct: request.product,
      expectedRole: request.product == CommercialGetStreamProduct.liveEvent
          ? CommercialGetStreamRole.viewer
          : CommercialGetStreamRole.buyer,
    );
  }
}
