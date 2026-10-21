---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

Framework detection no longer names a framework because a page talks about one. A page that shows what Next.js emits inside a code sample carried `/_next/static/` and `self.__next_f` as escaped text, and the test report said "Detected: Next.js" for a plain HTML site. Every asset signal now has to sit in the `src` or `href` of a real script, link or img tag, every hydration payload at the start of a real inline script, and every element id on a real element, which is where the frameworks put them and where escaped text cannot.
