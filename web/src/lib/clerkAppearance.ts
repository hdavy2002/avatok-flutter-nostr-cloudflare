/* Shared Clerk appearance — themes Clerk's <SignIn/> & <SignUp/> to the avatok
 * "zine" brand (cream paper, ink borders, hard shadow, Fredoka/Nunito, lime
 * primary) so the auth screens match the rest of the site instead of Clerk's
 * default look. Used by SignInPanel / SignUpPanel.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#231B14',
    colorText: '#231B14',
    colorTextSecondary: '#5b5249',
    colorBackground: '#FFFFFF',
    colorInputBackground: '#F9F7ED',
    colorInputText: '#231B14',
    colorDanger: '#FE674C',
    borderRadius: '14px',
    fontFamily: "'Nunito', sans-serif",
    fontWeight: { normal: '700', medium: '700', bold: '800' },
  },
  elements: {
    rootBox: { width: '100%' },
    card: {
      backgroundColor: '#FFFFFF',
      border: '2px solid #231B14',
      borderRadius: '20px',
      boxShadow: '5px 6px 0 0 #231B14',
    },
    headerTitle: { fontFamily: "'Fredoka', sans-serif", fontWeight: '600', fontSize: '24px' },
    headerSubtitle: { color: '#5b5249', fontWeight: '700' },
    socialButtonsBlockButton: {
      border: '2px solid #231B14',
      borderRadius: '999px',
      boxShadow: '2px 2px 0 0 #231B14',
      fontWeight: '800',
    },
    formButtonPrimary: {
      backgroundColor: '#BFEB56',
      color: '#231B14',
      border: '2px solid #231B14',
      borderRadius: '999px',
      boxShadow: '3px 3px 0 0 #231B14',
      fontFamily: "'Space Mono', monospace",
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      '&:hover': { backgroundColor: '#b3e043', transform: 'translateY(-1px)' },
    },
    formFieldInput: {
      border: '2px solid #231B14',
      borderRadius: '12px',
      backgroundColor: '#F9F7ED',
      fontWeight: '700',
    },
    formFieldLabel: { fontWeight: '800', color: '#231B14' },
    footerActionLink: { color: '#007D7F', fontWeight: '800' },
    badge: { backgroundColor: '#BFEB56', color: '#231B14' },
    dividerLine: { backgroundColor: '#231B14' },
    dividerText: { color: '#5b5249', fontWeight: '700' },
  },
} as const;
