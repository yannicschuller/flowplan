"use client";
import { useEffect, useState } from "react";
import { parsePageLocation } from "@/lib/page-location";
import Login from "../login";
import Landing from "./landing";
import type { LoginOptions } from "@/lib/local-auth";

type Props = LoginOptions & {
  error?: string;
  instanceName: string;
  demoEnabled?: boolean;
};
// Visitors see the product page. A link to a page (#page=…) or a failed
// sign-in leads straight to the sign-in card instead, so deep links still
// return to their page after signing in.
export default function PublicHome(props: Props) {
  const [signIn, setSignIn] = useState(!!props.error);
  useEffect(() => {
    const check = () => {
      if (parsePageLocation(location.hash)) setSignIn(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  if (signIn) return <Login {...props} />;
  return (
    <Landing
      loginHref={props.localLogin || !props.configured ? "/login" : "/api/auth/login"}
      registerHref={props.localLogin ? "/register" : props.configured ? "/api/auth/login?register=1" : "/login"}
      instanceName={props.instanceName}
      demoEnabled={props.demoEnabled}
    />
  );
}
