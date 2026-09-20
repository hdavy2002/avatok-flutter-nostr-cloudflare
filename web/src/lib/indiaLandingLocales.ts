/** Reviewed-key chrome translations for the India creator landing page.
 * Page copy is added by the page worker through the same flat-key contract.
 * No locale falls back to an English spread: every chrome key is present in
 * every dictionary so a partial language never silently masquerades as one.
 */
export type IndiaLandingLocaleCode =
  | 'en' | 'hi-Latn' | 'as' | 'bn' | 'brx' | 'doi' | 'gu' | 'hi' | 'kn'
  | 'ks' | 'kok' | 'mai' | 'ml' | 'mni' | 'mr' | 'ne' | 'or' | 'pa'
  | 'sa' | 'sat' | 'sd' | 'ta' | 'te' | 'ur';

export type IndiaLandingDictionary = Record<string, string>;
export interface IndiaLandingLocale {
  code: IndiaLandingLocaleCode;
  nativeName: string;
  dir: 'ltr' | 'rtl';
  translations: IndiaLandingDictionary;
}

export const defaultLocale: IndiaLandingLocaleCode = 'hi-Latn';
const chromeEnglish: IndiaLandingDictionary = {
  'chrome.home': 'Saathum home', 'chrome.mainNav': 'Main', 'chrome.menu': 'Menu',
  'chrome.login': 'Log in', 'chrome.signup': 'Sign up', 'chrome.dashboard': 'Dashboard',
  'chrome.signout': 'Sign out', 'chrome.chooseLanguage': 'Choose language',
  'chrome.footerNav': 'Footer', 'chrome.legal': 'Legal and safety',
  'chrome.help': 'Help centre', 'chrome.terms': 'Terms of Service',
  'chrome.marketplace':'Marketplace', 'chrome.wiki':'Wiki', 'chrome.pricing':'Pricing', 'chrome.ideas':'Ideas', 'chrome.forCreators':'For creators', 'chrome.howItWorks':'How it works', 'chrome.payouts':'Payouts',
  'chrome.bazaar':'Bazaar', 'chrome.creators':'Creators', 'chrome.company':'Company', 'chrome.explore':'Explore', 'chrome.liveStreaming':'Live streaming', 'chrome.findPeople':'Find your people', 'chrome.exploreMarketplace':'Explore marketplace', 'chrome.startSelling':'Start selling', 'chrome.creatorDashboard':'Creator dashboard', 'chrome.safety':'Safety', 'chrome.about':'About', 'chrome.careers':'Careers', 'chrome.contact':'Contact', 'chrome.privacy':'Privacy Policy', 'chrome.cookies':'Cookies', 'chrome.refunds':'Refunds', 'chrome.marketplaceTerms':'Marketplace Terms', 'chrome.consultationTerms':'Consultation Terms', 'chrome.acceptableUse':'Acceptable Use', 'chrome.recordingConsent':'Recording & Consent', 'chrome.biometricData':'Biometric Data', 'chrome.dmca':'DMCA', 'chrome.communityGuidelines':'Community Guidelines', 'chrome.childSafety':'Child Safety', 'chrome.grievance':'Grievance Redressal', 'chrome.contactReport':'Contact & Report', 'chrome.pricingFees':'Pricing & Fees', 'chrome.tokensWallet':'Tokens & Wallet',
};
const chrome: Record<IndiaLandingLocaleCode, IndiaLandingDictionary> = {
  en: chromeEnglish,
  'hi-Latn': {'chrome.home':'Saathum home','chrome.mainNav':'Mukhya menu','chrome.menu':'Menu','chrome.login':'Log in','chrome.signup':'Sign up','chrome.dashboard':'Dashboard','chrome.signout':'Sign out','chrome.chooseLanguage':'Bhasha chunein','chrome.footerNav':'Footer','chrome.legal':'Kanooni jaankari aur suraksha','chrome.help':'Help centre','chrome.terms':'Seva ki shartein'},
  as: {'chrome.home':'Saathum মূল পৃষ্ঠা','chrome.mainNav':'মুখ্য মেনু','chrome.menu':'মেনু','chrome.login':'লগ ইন','chrome.signup':'চাইন আপ','chrome.dashboard':'ডেশব’ৰ্ড','chrome.signout':'ছাইন আউট','chrome.chooseLanguage':'ভাষা বাছক','chrome.footerNav':'ফুটাৰ','chrome.legal':'আইনী আৰু সুৰক্ষা','chrome.help':'সহায় কেন্দ্ৰ','chrome.terms':'সেৱাৰ চৰ্ত'},
  bn: {'chrome.home':'Saathum হোম','chrome.mainNav':'প্রধান মেনু','chrome.menu':'মেনু','chrome.login':'লগ ইন','chrome.signup':'সাইন আপ','chrome.dashboard':'ড্যাশবোর্ড','chrome.signout':'সাইন আউট','chrome.chooseLanguage':'ভাষা বাছুন','chrome.footerNav':'ফুটার','chrome.legal':'আইনি ও নিরাপত্তা','chrome.help':'সহায়তা কেন্দ্র','chrome.terms':'পরিষেবার শর্ত'},
  brx: {'chrome.home':'Saathum होम','chrome.mainNav':'मुख्य मेनु','chrome.menu':'मेनु','chrome.login':'लग इन','chrome.signup':'साइन अप','chrome.dashboard':'डैशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'राव बाछ','chrome.footerNav':'फुटार','chrome.legal':'कानूनी आरो रैखा','chrome.help':'मदद केन्द्र','chrome.terms':'सेवा सर्त'},
  doi: {'chrome.home':'Saathum घर','chrome.mainNav':'मुख्य मेनू','chrome.menu':'मेनू','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डैशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भाशा चुनो','chrome.footerNav':'फुटर','chrome.legal':'कानूनी ते सुरक्षा','chrome.help':'मदद केंद्र','chrome.terms':'सेवा शर्तां'},
  gu: {'chrome.home':'Saathum હોમ','chrome.mainNav':'મુખ્ય મેનુ','chrome.menu':'મેનુ','chrome.login':'લૉગ ઇન','chrome.signup':'સાઇન અપ','chrome.dashboard':'ડેશબોર્ડ','chrome.signout':'સાઇન આઉટ','chrome.chooseLanguage':'ભાષા પસંદ કરો','chrome.footerNav':'ફૂટર','chrome.legal':'કાયદાકીય અને સુરક્ષા','chrome.help':'મદદ કેન્દ્ર','chrome.terms':'સેવાની શરતો'},
  hi: {'chrome.home':'Saathum होम','chrome.mainNav':'मुख्य मेनू','chrome.menu':'मेनू','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डैशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भाषा चुनें','chrome.footerNav':'फुटर','chrome.legal':'कानूनी और सुरक्षा','chrome.help':'सहायता केंद्र','chrome.terms':'सेवा की शर्तें'},
  kn: {'chrome.home':'Saathum ಮುಖಪುಟ','chrome.mainNav':'ಮುಖ್ಯ ಮೆನು','chrome.menu':'ಮೆನು','chrome.login':'ಲಾಗಿನ್','chrome.signup':'ಸೈನ್ ಅಪ್','chrome.dashboard':'ಡ್ಯಾಶ್‌ಬೋರ್ಡ್','chrome.signout':'ಸೈನ್ ಔಟ್','chrome.chooseLanguage':'ಭಾಷೆ ಆಯ್ಕೆಮಾಡಿ','chrome.footerNav':'ಅಡಿಪಟ್ಟಿ','chrome.legal':'ಕಾನೂನು ಮತ್ತು ಸುರಕ್ಷತೆ','chrome.help':'ಸಹಾಯ ಕೇಂದ್ರ','chrome.terms':'ಸೇವಾ ನಿಯಮಗಳು'},
  ks: {'chrome.home':'Saathum ہوم','chrome.mainNav':'بنیٛادی مینیو','chrome.menu':'مینیو','chrome.login':'لاگ اِن','chrome.signup':'ساین اَپ','chrome.dashboard':'ڈیش بورڈ','chrome.signout':'ساین آؤٹ','chrome.chooseLanguage':'زبان ژٕ چون','chrome.footerNav':'فُٹر','chrome.legal':'قانونی تہٕ حفاظت','chrome.help':'مدد مرکز','chrome.terms':'خدمت شرٛط'},
  kok: {'chrome.home':'Saathum होम','chrome.mainNav':'मुखेल मेनू','chrome.menu':'मेनू','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डॅशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भास निवडात','chrome.footerNav':'फुटर','chrome.legal':'कायदेशीर आनी सुरक्षीत','chrome.help':'मजत केंद्र','chrome.terms':'सेवेचीं अटी'},
  mai: {'chrome.home':'Saathum होम','chrome.mainNav':'मुख्य मेनू','chrome.menu':'मेनू','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डैशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भाषा चुनू','chrome.footerNav':'फुटर','chrome.legal':'कानूनी आ सुरक्षा','chrome.help':'सहायता केन्द्र','chrome.terms':'सेवा के शर्त'},
  ml: {'chrome.home':'Saathum ഹോം','chrome.mainNav':'പ്രധാന മെനു','chrome.menu':'മെനു','chrome.login':'ലോഗിൻ','chrome.signup':'സൈൻ അപ്പ്','chrome.dashboard':'ഡാഷ്ബോർഡ്','chrome.signout':'സൈൻ ഔട്ട്','chrome.chooseLanguage':'ഭാഷ തിരഞ്ഞെടുക്കുക','chrome.footerNav':'ഫൂട്ടർ','chrome.legal':'നിയമവും സുരക്ഷയും','chrome.help':'സഹായ കേന്ദ്രം','chrome.terms':'സേവന നിബന്ധനകൾ'},
  mni: {'chrome.home':'Saathum ꯍꯣꯝ','chrome.mainNav':'ꯃꯈꯥꯜ ꯃꯦꯅꯨ','chrome.menu':'ꯃꯦꯅꯨ','chrome.login':'ꯂꯣꯒ ꯏꯟ','chrome.signup':'ꯁꯥꯏꯟ ꯑꯞ','chrome.dashboard':'ꯗꯥꯁꯕꯣꯔꯗ','chrome.signout':'ꯁꯥꯏꯟ ꯑꯥꯎꯠ','chrome.chooseLanguage':'ꯂꯣꯟ ꯈꯟꯕꯤꯌꯨ','chrome.footerNav':'ꯐꯨꯇꯔ','chrome.legal':'ꯀꯥꯅꯨꯅꯤ ꯑꯃꯁꯨꯡ ꯁꯥꯐꯦꯇꯤ','chrome.help':'ꯍꯦꯜꯞ ꯁꯦꯟꯇꯔ','chrome.terms':'ꯁꯔꯕꯤꯁ ꯇꯔꯝ'},
  mr: {'chrome.home':'Saathum होम','chrome.mainNav':'मुख्य मेनू','chrome.menu':'मेनू','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डॅशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भाषा निवडा','chrome.footerNav':'फूटर','chrome.legal':'कायदेशीर आणि सुरक्षितता','chrome.help':'मदत केंद्र','chrome.terms':'सेवेच्या अटी'},
  ne: {'chrome.home':'Saathum गृहपृष्ठ','chrome.mainNav':'मुख्य मेनु','chrome.menu':'मेनु','chrome.login':'लग इन','chrome.signup':'साइन अप','chrome.dashboard':'ड्यासबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'भाषा छान्नुहोस्','chrome.footerNav':'फुटर','chrome.legal':'कानुनी र सुरक्षा','chrome.help':'सहायता केन्द्र','chrome.terms':'सेवाका सर्तहरू'},
  or: {'chrome.home':'Saathum ମୁଖ୍ୟପୃଷ୍ଠା','chrome.mainNav':'ମୁଖ୍ୟ ମେନୁ','chrome.menu':'ମେନୁ','chrome.login':'ଲଗ୍ ଇନ୍','chrome.signup':'ସାଇନ୍ ଅପ୍','chrome.dashboard':'ଡ୍ୟାସବୋର୍ଡ','chrome.signout':'ସାଇନ୍ ଆଉଟ୍','chrome.chooseLanguage':'ଭାଷା ବାଛନ୍ତୁ','chrome.footerNav':'ଫୁଟର୍','chrome.legal':'ଆଇନ ଓ ସୁରକ୍ଷା','chrome.help':'ସହାୟତା କେନ୍ଦ୍ର','chrome.terms':'ସେବା ସର୍ତ୍ତାବଳୀ'},
  pa: {'chrome.home':'Saathum ਘਰ','chrome.mainNav':'ਮੁੱਖ ਮੀਨੂ','chrome.menu':'ਮੀਨੂ','chrome.login':'ਲੌਗ ਇਨ','chrome.signup':'ਸਾਈਨ ਅਪ','chrome.dashboard':'ਡੈਸ਼ਬੋਰਡ','chrome.signout':'ਸਾਈਨ ਆਉਟ','chrome.chooseLanguage':'ਭਾਸ਼ਾ ਚੁਣੋ','chrome.footerNav':'ਫੁੱਟਰ','chrome.legal':'ਕਾਨੂੰਨੀ ਅਤੇ ਸੁਰੱਖਿਆ','chrome.help':'ਮਦਦ ਕੇਂਦਰ','chrome.terms':'ਸੇਵਾ ਦੀਆਂ ਸ਼ਰਤਾਂ'},
  sa: {'chrome.home':'Saathum गृहम्','chrome.mainNav':'मुख्यं मेनु','chrome.menu':'मेनु','chrome.login':'प्रवेशः','chrome.signup':'पञ्जीकरणम्','chrome.dashboard':'पटलम्','chrome.signout':'निर्गमनम्','chrome.chooseLanguage':'भाषां चिनुत','chrome.footerNav':'पादभागः','chrome.legal':'वैधानिकं सुरक्षा च','chrome.help':'साहाय्यकेन्द्रम्','chrome.terms':'सेवाशर्ताः'},
  sat: {'chrome.home':'Saathum ओड़ाक्','chrome.mainNav':'मारे मेनु','chrome.menu':'मेनु','chrome.login':'लॉग इन','chrome.signup':'साइन अप','chrome.dashboard':'डैशबोर्ड','chrome.signout':'साइन आउट','chrome.chooseLanguage':'पारसी बाछाव','chrome.footerNav':'फुटर','chrome.legal':'कानून आर बाचाव','chrome.help':'मदद केन्द्र','chrome.terms':'सेवा नेयम'},
  sd: {'chrome.home':'Saathum گهر','chrome.mainNav':'مکيه مينيو','chrome.menu':'مينيو','chrome.login':'لاگ ان','chrome.signup':'سائن اپ','chrome.dashboard':'ڊيش بورڊ','chrome.signout':'سائن آئوٽ','chrome.chooseLanguage':'ٻولي چونڊيو','chrome.footerNav':'فوٽر','chrome.legal':'قانوني ۽ حفاظت','chrome.help':'مدد مرڪز','chrome.terms':'خدمت جون شرطون'},
  ta: {'chrome.home':'Saathum முகப்பு','chrome.mainNav':'முதன்மை மெனு','chrome.menu':'மெனு','chrome.login':'உள்நுழை','chrome.signup':'பதிவு செய்','chrome.dashboard':'டாஷ்போர்டு','chrome.signout':'வெளியேறு','chrome.chooseLanguage':'மொழியைத் தேர்ந்தெடுக்கவும்','chrome.footerNav':'அடிப்பகுதி','chrome.legal':'சட்டமும் பாதுகாப்பும்','chrome.help':'உதவி மையம்','chrome.terms':'சேவை விதிமுறைகள்'},
  te: {'chrome.home':'Saathum హోమ్','chrome.mainNav':'ప్రధాన మెనూ','chrome.menu':'మెనూ','chrome.login':'లాగిన్','chrome.signup':'సైన్ అప్','chrome.dashboard':'డాష్‌బోర్డ్','chrome.signout':'సైన్ అవుట్','chrome.chooseLanguage':'భాషను ఎంచుకోండి','chrome.footerNav':'ఫుటర్','chrome.legal':'చట్టపరమైన మరియు భద్రత','chrome.help':'సహాయ కేంద్రం','chrome.terms':'సేవా నిబంధనలు'},
  ur: {'chrome.home':'Saathum ہوم','chrome.mainNav':'مرکزی مینیو','chrome.menu':'مینیو','chrome.login':'لاگ اِن','chrome.signup':'سائن اَپ','chrome.dashboard':'ڈیش بورڈ','chrome.signout':'سائن آؤٹ','chrome.chooseLanguage':'زبان منتخب کریں','chrome.footerNav':'فُٹر','chrome.legal':'قانونی اور حفاظت','chrome.help':'مدد مرکز','chrome.terms':'سروس کی شرائط'},
};

const names: Array<[IndiaLandingLocaleCode, string, 'ltr' | 'rtl']> = [
  ['en','English','ltr'],['hi-Latn','Hinglish','ltr'],['as','অসমীয়া','ltr'],['bn','বাংলা','ltr'],['brx','बड़ो','ltr'],['doi','डोगरी','ltr'],['gu','ગુજરાતી','ltr'],['hi','हिन्दी','ltr'],['kn','ಕನ್ನಡ','ltr'],['ks','کٲشُر','rtl'],['kok','कोंकणी','ltr'],['mai','मैथिली','ltr'],['ml','മലയാളം','ltr'],['mni','ꯃꯤꯇꯩ ꯂꯣꯟ','ltr'],['mr','मराठी','ltr'],['ne','नेपाली','ltr'],['or','ଓଡ଼ିଆ','ltr'],['pa','ਪੰਜਾਬੀ','ltr'],['sa','संस्कृतम्','ltr'],['sat','ᱥᱟᱱᱛᱟᱲᱤ','ltr'],['sd','سنڌي','rtl'],['ta','தமிழ்','ltr'],['te','తెలుగు','ltr'],['ur','اُردُو','rtl'],
];
export const indiaLandingLocales: IndiaLandingLocale[] = names.map(([code, nativeName, dir]) => ({ code, nativeName, dir, translations: chrome[code] }));
export const getIndiaLandingLocale = (code: string) => indiaLandingLocales.find((item) => item.code === code) ?? indiaLandingLocales.find((item) => item.code === defaultLocale)!;
