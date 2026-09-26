"use client";
import { useEffect, useState } from "react";
import { parsePageLocation } from "@/lib/page-location";
import Login from "../login";
import Landing from "./landing";

type Props = {
  demo: boolean;
  configured: boolean;
  error?: string;
  instanceName: string;
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
      loginHref={props.configured ? "/api/auth/login" : "/login"}
      registerHref={props.configured ? "/api/auth/login?register=1" : "/login"}
      instanceName={props.instanceName}
    />
  );
}
