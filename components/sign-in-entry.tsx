"use client";
// What the root page (app/page.tsx) renders for someone who is not signed in
// yet: the sign-in, or the second factor the instance requires. Like
// components/app-entry.tsx they load through next/dynamic, so their code
// (forms, passkeys, the second factor) comes only with the page that shows
// them – not with every signed-in page, which imports this module too.
// Still rendered on the server, their files preloaded with the page.
import dynamic from "next/dynamic";

export const SignIn = dynamic(() => import("./login"));
export const SecondFactorRequired = dynamic(() => import("./two-factor").then((m) => m.TwoFactorRequired));
