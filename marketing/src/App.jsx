// avaTOK landing — React wrapper around the editorial/zine theme.
// The markup and the page script are imported from themeContent.js, which is
// generated 1:1 from theme/AvaTOK Landing (offline).html. The markup renders as
// real HTML; the original vanilla script runs once after mount.
import { useEffect, useRef } from "react";
import { BODY, SCRIPT } from "./themeContent.js";

export default function App() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; // guard StrictMode double-invoke in dev
    ran.current = true;
    const s = document.createElement("script");
    s.textContent = SCRIPT;
    document.body.appendChild(s);
  }, []);
  return <div dangerouslySetInnerHTML={{ __html: BODY }} />;
}
