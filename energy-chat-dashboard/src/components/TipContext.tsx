import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";

type TipState = {
  message: string | null;
  visible: boolean;
};

type TipContextValue = {
  tip: TipState;
  showTip: (message: string, autoDismissMs?: number) => void;
  dismissTip: () => void;
};

const TipContext = createContext<TipContextValue | null>(null);

export function TipProvider({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<TipState>({ message: null, visible: false });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissTip = useCallback(() => {
    setTip({ message: null, visible: false });
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showTip = useCallback((message: string, autoDismissMs = 15000) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setTip({ message, visible: true });
    timerRef.current = setTimeout(() => {
      setTip({ message: null, visible: false });
      timerRef.current = null;
    }, autoDismissMs);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <TipContext.Provider value={{ tip, showTip, dismissTip }}>
      {children}
    </TipContext.Provider>
  );
}

export function useTip(): TipContextValue {
  const ctx = useContext(TipContext);
  if (!ctx) {
    throw new Error("useTip must be used within a <TipProvider>");
  }
  return ctx;
}
