export interface TelegramLocationData {
  latitude: number;
  longitude: number;
  horizontal_accuracy: number | null;
  speed: number | null;
  course: number | null;
}

interface TelegramLocationManager {
  isInited: boolean;
  isLocationAvailable: boolean;
  isAccessGranted: boolean;
  init(callback?: () => void): void;
  getLocation(callback: (location: TelegramLocationData | null) => void): void;
  openSettings(): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { id: number; first_name: string } };
  platform: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  requestFullscreen?: () => void;
  enableClosingConfirmation(): void;
  openTelegramLink(url: string): void;
  HapticFeedback?: { impactOccurred(style: "light" | "medium" | "heavy"): void; notificationOccurred(type: "error" | "success" | "warning"): void };
  LocationManager?: TelegramLocationManager;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export const telegram = () => window.Telegram?.WebApp;

export function initializeTelegram() {
  const app = telegram();
  if (!app) return;
  app.ready();
  app.expand();
  app.enableClosingConfirmation();
}

export async function requestTelegramLocation(): Promise<TelegramLocationData | null> {
  const manager = telegram()?.LocationManager;
  if (!manager) return null;
  if (!manager.isInited) await new Promise<void>((resolve) => manager.init(resolve));
  if (!manager.isLocationAvailable) return null;
  return new Promise((resolve) => manager.getLocation(resolve));
}

export function hapticSuccess() {
  telegram()?.HapticFeedback?.notificationOccurred("success");
}

export function hapticError() {
  telegram()?.HapticFeedback?.notificationOccurred("error");
}
