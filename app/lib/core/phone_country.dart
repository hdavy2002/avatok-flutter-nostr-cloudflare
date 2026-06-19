/// Lightweight E.164 → country resolver, used purely for **telemetry**.
///
/// When a user enters a phone number for OTP (or fails / skips it), we want
/// PostHog to know which country the number came from — so support can see, for
/// example, "OTP send is failing for +234 (Nigeria) numbers" without storing the
/// raw number anywhere it shouldn't be. This is intentionally dependency-free
/// (no libphonenumber) and matches on the calling-code prefix only; it does NOT
/// validate the national number. Never throws.
class PhoneCountry {
  final String dialCode; // e.g. "+234"
  final String iso2; // e.g. "NG" ("ZZ" when unknown)
  final String name; // e.g. "Nigeria"
  const PhoneCountry(this.dialCode, this.iso2, this.name);

  static const PhoneCountry unknown = PhoneCountry('', 'ZZ', 'Unknown');

  /// Resolve a country from an E.164-ish string. Accepts spaces / dashes /
  /// parentheses and an optional leading '+' or '00'. Returns [unknown] when the
  /// prefix matches nothing (e.g. the field still holds just "+").
  static PhoneCountry fromE164(String? raw) {
    if (raw == null) return unknown;
    var s = raw.trim();
    if (s.isEmpty) return unknown;
    // Normalise: drop everything except digits, remember it was intl.
    if (s.startsWith('00')) s = s.substring(2);
    final digits = s.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.isEmpty) return unknown;
    // Try the longest possible calling code first (codes are 1–4 digits).
    for (var len = 4; len >= 1; len--) {
      if (digits.length < len) continue;
      final code = digits.substring(0, len);
      final hit = _byCode[code];
      if (hit != null) return PhoneCountry('+$code', hit[0], hit[1]);
    }
    return unknown;
  }

  /// Just the dial code (e.g. "+234"), or '' if unresolved.
  static String dialCodeOf(String? raw) => fromE164(raw).dialCode;

  /// ISO-3166 alpha-2 (e.g. "NG"), or "ZZ" if unresolved.
  static String iso2Of(String? raw) => fromE164(raw).iso2;

  // Calling code → [iso2, name]. Longest-prefix match handled by [fromE164].
  // NANP (+1) plus the +1NXX area-code split-outs for the larger Caribbean
  // members so a Jamaican/Trinidad number isn't mislabelled "United States".
  static const Map<String, List<String>> _byCode = {
    // North American Numbering Plan
    '1': ['US', 'United States/Canada'],
    '1242': ['BS', 'Bahamas'], '1246': ['BB', 'Barbados'], '1264': ['AI', 'Anguilla'],
    '1268': ['AG', 'Antigua and Barbuda'], '1284': ['VG', 'British Virgin Islands'],
    '1340': ['VI', 'US Virgin Islands'], '1345': ['KY', 'Cayman Islands'],
    '1441': ['BM', 'Bermuda'], '1473': ['GD', 'Grenada'], '1649': ['TC', 'Turks and Caicos'],
    '1664': ['MS', 'Montserrat'], '1670': ['MP', 'Northern Mariana Islands'],
    '1671': ['GU', 'Guam'], '1684': ['AS', 'American Samoa'], '1758': ['LC', 'Saint Lucia'],
    '1767': ['DM', 'Dominica'], '1784': ['VC', 'Saint Vincent'], '1787': ['PR', 'Puerto Rico'],
    '1809': ['DO', 'Dominican Republic'], '1868': ['TT', 'Trinidad and Tobago'],
    '1869': ['KN', 'Saint Kitts and Nevis'], '1876': ['JM', 'Jamaica'],
    // Zone 2 — mostly Africa
    '20': ['EG', 'Egypt'], '211': ['SS', 'South Sudan'], '212': ['MA', 'Morocco'],
    '213': ['DZ', 'Algeria'], '216': ['TN', 'Tunisia'], '218': ['LY', 'Libya'],
    '220': ['GM', 'Gambia'], '221': ['SN', 'Senegal'], '222': ['MR', 'Mauritania'],
    '223': ['ML', 'Mali'], '224': ['GN', 'Guinea'], '225': ['CI', "Côte d'Ivoire"],
    '226': ['BF', 'Burkina Faso'], '227': ['NE', 'Niger'], '228': ['TG', 'Togo'],
    '229': ['BJ', 'Benin'], '230': ['MU', 'Mauritius'], '231': ['LR', 'Liberia'],
    '232': ['SL', 'Sierra Leone'], '233': ['GH', 'Ghana'], '234': ['NG', 'Nigeria'],
    '235': ['TD', 'Chad'], '236': ['CF', 'Central African Republic'], '237': ['CM', 'Cameroon'],
    '238': ['CV', 'Cape Verde'], '239': ['ST', 'São Tomé and Príncipe'], '240': ['GQ', 'Equatorial Guinea'],
    '241': ['GA', 'Gabon'], '242': ['CG', 'Congo'], '243': ['CD', 'DR Congo'],
    '244': ['AO', 'Angola'], '245': ['GW', 'Guinea-Bissau'], '246': ['IO', 'British Indian Ocean'],
    '248': ['SC', 'Seychelles'], '249': ['SD', 'Sudan'], '250': ['RW', 'Rwanda'],
    '251': ['ET', 'Ethiopia'], '252': ['SO', 'Somalia'], '253': ['DJ', 'Djibouti'],
    '254': ['KE', 'Kenya'], '255': ['TZ', 'Tanzania'], '256': ['UG', 'Uganda'],
    '257': ['BI', 'Burundi'], '258': ['MZ', 'Mozambique'], '260': ['ZM', 'Zambia'],
    '261': ['MG', 'Madagascar'], '262': ['RE', 'Réunion'], '263': ['ZW', 'Zimbabwe'],
    '264': ['NA', 'Namibia'], '265': ['MW', 'Malawi'], '266': ['LS', 'Lesotho'],
    '267': ['BW', 'Botswana'], '268': ['SZ', 'Eswatini'], '269': ['KM', 'Comoros'],
    '27': ['ZA', 'South Africa'], '290': ['SH', 'Saint Helena'], '291': ['ER', 'Eritrea'],
    '297': ['AW', 'Aruba'], '298': ['FO', 'Faroe Islands'], '299': ['GL', 'Greenland'],
    // Zone 3/4 — Europe
    '30': ['GR', 'Greece'], '31': ['NL', 'Netherlands'], '32': ['BE', 'Belgium'],
    '33': ['FR', 'France'], '34': ['ES', 'Spain'], '350': ['GI', 'Gibraltar'],
    '351': ['PT', 'Portugal'], '352': ['LU', 'Luxembourg'], '353': ['IE', 'Ireland'],
    '354': ['IS', 'Iceland'], '355': ['AL', 'Albania'], '356': ['MT', 'Malta'],
    '357': ['CY', 'Cyprus'], '358': ['FI', 'Finland'], '359': ['BG', 'Bulgaria'],
    '36': ['HU', 'Hungary'], '370': ['LT', 'Lithuania'], '371': ['LV', 'Latvia'],
    '372': ['EE', 'Estonia'], '373': ['MD', 'Moldova'], '374': ['AM', 'Armenia'],
    '375': ['BY', 'Belarus'], '376': ['AD', 'Andorra'], '377': ['MC', 'Monaco'],
    '378': ['SM', 'San Marino'], '380': ['UA', 'Ukraine'], '381': ['RS', 'Serbia'],
    '382': ['ME', 'Montenegro'], '383': ['XK', 'Kosovo'], '385': ['HR', 'Croatia'],
    '386': ['SI', 'Slovenia'], '387': ['BA', 'Bosnia and Herzegovina'], '389': ['MK', 'North Macedonia'],
    '39': ['IT', 'Italy'], '40': ['RO', 'Romania'], '41': ['CH', 'Switzerland'],
    '420': ['CZ', 'Czechia'], '421': ['SK', 'Slovakia'], '423': ['LI', 'Liechtenstein'],
    '43': ['AT', 'Austria'], '44': ['GB', 'United Kingdom'], '45': ['DK', 'Denmark'],
    '46': ['SE', 'Sweden'], '47': ['NO', 'Norway'], '48': ['PL', 'Poland'], '49': ['DE', 'Germany'],
    // Zone 5 — Central/South America
    '500': ['FK', 'Falkland Islands'], '501': ['BZ', 'Belize'], '502': ['GT', 'Guatemala'],
    '503': ['SV', 'El Salvador'], '504': ['HN', 'Honduras'], '505': ['NI', 'Nicaragua'],
    '506': ['CR', 'Costa Rica'], '507': ['PA', 'Panama'], '508': ['PM', 'Saint Pierre'],
    '509': ['HT', 'Haiti'], '51': ['PE', 'Peru'], '52': ['MX', 'Mexico'],
    '53': ['CU', 'Cuba'], '54': ['AR', 'Argentina'], '55': ['BR', 'Brazil'],
    '56': ['CL', 'Chile'], '57': ['CO', 'Colombia'], '58': ['VE', 'Venezuela'],
    '590': ['GP', 'Guadeloupe'], '591': ['BO', 'Bolivia'], '592': ['GY', 'Guyana'],
    '593': ['EC', 'Ecuador'], '594': ['GF', 'French Guiana'], '595': ['PY', 'Paraguay'],
    '596': ['MQ', 'Martinique'], '597': ['SR', 'Suriname'], '598': ['UY', 'Uruguay'],
    '599': ['CW', 'Curaçao'],
    // Zone 6 — Southeast Asia / Oceania
    '60': ['MY', 'Malaysia'], '61': ['AU', 'Australia'], '62': ['ID', 'Indonesia'],
    '63': ['PH', 'Philippines'], '64': ['NZ', 'New Zealand'], '65': ['SG', 'Singapore'],
    '66': ['TH', 'Thailand'], '670': ['TL', 'Timor-Leste'], '673': ['BN', 'Brunei'],
    '674': ['NR', 'Nauru'], '675': ['PG', 'Papua New Guinea'], '676': ['TO', 'Tonga'],
    '677': ['SB', 'Solomon Islands'], '678': ['VU', 'Vanuatu'], '679': ['FJ', 'Fiji'],
    '680': ['PW', 'Palau'], '685': ['WS', 'Samoa'], '686': ['KI', 'Kiribati'],
    '687': ['NC', 'New Caledonia'], '689': ['PF', 'French Polynesia'],
    // Zone 7 — Russia / Kazakhstan
    '7': ['RU', 'Russia/Kazakhstan'],
    // Zone 8 — East Asia
    '81': ['JP', 'Japan'], '82': ['KR', 'South Korea'], '84': ['VN', 'Vietnam'],
    '850': ['KP', 'North Korea'], '852': ['HK', 'Hong Kong'], '853': ['MO', 'Macau'],
    '855': ['KH', 'Cambodia'], '856': ['LA', 'Laos'], '86': ['CN', 'China'],
    '880': ['BD', 'Bangladesh'], '886': ['TW', 'Taiwan'],
    // Zone 9 — South/West Asia
    '90': ['TR', 'Turkey'], '91': ['IN', 'India'], '92': ['PK', 'Pakistan'],
    '93': ['AF', 'Afghanistan'], '94': ['LK', 'Sri Lanka'], '95': ['MM', 'Myanmar'],
    '960': ['MV', 'Maldives'], '961': ['LB', 'Lebanon'], '962': ['JO', 'Jordan'],
    '963': ['SY', 'Syria'], '964': ['IQ', 'Iraq'], '965': ['KW', 'Kuwait'],
    '966': ['SA', 'Saudi Arabia'], '967': ['YE', 'Yemen'], '968': ['OM', 'Oman'],
    '970': ['PS', 'Palestine'], '971': ['AE', 'United Arab Emirates'], '972': ['IL', 'Israel'],
    '973': ['BH', 'Bahrain'], '974': ['QA', 'Qatar'], '975': ['BT', 'Bhutan'],
    '976': ['MN', 'Mongolia'], '977': ['NP', 'Nepal'], '98': ['IR', 'Iran'],
    '992': ['TJ', 'Tajikistan'], '993': ['TM', 'Turkmenistan'], '994': ['AZ', 'Azerbaijan'],
    '995': ['GE', 'Georgia'], '996': ['KG', 'Kyrgyzstan'], '998': ['UZ', 'Uzbekistan'],
  };
}
