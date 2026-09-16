import { chromeScripts } from './chromeScripts';
import { chromeSouthEast } from './chromeSouthEast';
import { chromeTamilTelugu } from './chromeTamilTelugu';
import { chromeHindiMarathi } from './chromeHindiMarathi';
import { chromeNorthRtl } from './chromeNorthRtl';
import { chromeRegionalRtl } from './chromeRegionalRtl';
import { chromeBengali } from './chromeBengali';
const keys='marketplace|wiki|pricing|ideas|bazaar|creators|company|explore|liveStreaming|findPeople|exploreMarketplace|startSelling|creatorDashboard|payouts|safety|about|careers|contact|privacy|cookies|refunds|marketplaceTerms|consultationTerms|acceptableUse|recordingConsent|biometricData|dmca|communityGuidelines|childSafety|grievance|contactReport|pricingFees|tokensWallet|tagline|voice|goodbye|comeAgain|roadMotto|madeWith'.split('|');
const rows:Record<string,string>={
en:"Marketplace|Wiki|Pricing|Ideas|Bazaar|Creators|Company|Explore|Live streaming|Find your people|Explore marketplace|Start selling|Creator dashboard|Payouts|Safety|About|Careers|Contact|Privacy Policy|Cookies|Refunds|Marketplace Terms|Consultation Terms|Acceptable Use|Recording & Consent|Biometric Data|DMCA|Community Guidelines|Child Safety|Grievance Redressal|Contact & Report|Pricing & Fees|Tokens & Wallet|India's live creator bazaar. Book a seat and spend time together.|Your voice, to the world.|Bye for now · See you again|Come again!|Drive safely|Made with love and cutting chai",
'hi-Latn':"Marketplace|Wiki|Pricing|Ideas|Bazaar|Creators|Company|Explore|Live streaming|Find your people|Explore marketplace|Start selling|Creator dashboard|Payouts|Safety|About|Careers|Contact|Privacy Policy|Cookies|Refunds|Marketplace Terms|Consultation Terms|Acceptable Use|Recording & Consent|Biometric Data|DMCA|Community Guidelines|Child Safety|Grievance Redressal|Contact & Report|Pricing & Fees|Tokens & Wallet|India's live creator bazaar. Seat book karo, kursi kheencho, apna time lo.|Aapki awaaz, duniya tak.|OK TATA · PHIR MILENGE|फिर आना!|BURI NAZAR WALE, TERA MUH KALA · USE DIPPER AT NIGHT|MADE WITH ♥ AND CUTTING CHAI",
gu:"માર્કેટપ્લેસ|માર્ગદર્શિકા|કિંમત|વિચારો|બજાર|ક્રિએટર્સ|કંપની|શોધો|લાઇવ પ્રસારણ|તમારા લોકોને શોધો|માર્કેટપ્લેસ જુઓ|વેચવાનું શરૂ કરો|ક્રિએટર ડૅશબોર્ડ|ચુકવણી|સુરક્ષા|અમારા વિશે|કારકિર્દી|સંપર્ક|ગોપનીયતા નીતિ|કૂકીઝ|રિફંડ|માર્કેટપ્લેસની શરતો|પરામર્શની શરતો|સ્વીકાર્ય ઉપયોગ|રેકોર્ડિંગ અને સંમતિ|બાયોમેટ્રિક માહિતી|કૉપિરાઇટ ફરિયાદ|સમુદાય માર્ગદર્શિકા|બાળ સુરક્ષા|ફરિયાદ નિવારણ|સંપર્ક અને ફરિયાદ|કિંમત અને ફી|ટોકન્સ અને વૉલેટ|ભારતનું લાઇવ ક્રિએટર બજાર. જગ્યા બુક કરો અને સાથે સમય વિતાવો.|તમારો અવાજ, દુનિયા સુધી.|આવજો · ફરી મળીશું|ફરી આવજો!|સાવચેતીથી વાહન ચલાવો|પ્રેમ અને કટિંગ ચા સાથે બનાવેલું"
};
export const indiaChromeDictionaries:Record<string,Record<string,string>>=Object.fromEntries(Object.entries(rows).map(([code,row])=>{const values=row.split('|');if(values.length!==keys.length)throw new Error('Chrome translation count: '+code);return [code,Object.fromEntries(keys.map((key,i)=>['chrome.'+key,values[i]]))];}));
Object.assign(indiaChromeDictionaries,chromeHindiMarathi);
Object.assign(indiaChromeDictionaries,chromeNorthRtl);
Object.assign(indiaChromeDictionaries,chromeRegionalRtl);
indiaChromeDictionaries.bn=chromeBengali;
Object.assign(indiaChromeDictionaries,chromeTamilTelugu);
Object.assign(indiaChromeDictionaries,chromeSouthEast);
Object.assign(indiaChromeDictionaries,chromeScripts);
