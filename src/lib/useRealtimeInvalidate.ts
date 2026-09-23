import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabaseClient";
import { subscribeBusinessChanges, type ConnectionState } from "./businessRealtime";

export function useRealtimeInvalidate(enabled: boolean) {
  const cache = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    return subscribeBusinessChanges(supabase, cache, setState);
  }, [enabled, cache]);
  return state;
}
