import { useAtom } from "jotai";
import { useCallback } from "react";
import { currentViewAtom, errorAtom, isDarkModeAtom, isShortcutsHelpOpenAtom } from "../atoms";

export function useTerminalUI() {
  const [isDarkMode, setIsDarkMode] = useAtom(isDarkModeAtom);
  const [error, setError] = useAtom(errorAtom);
  const [isShortcutsHelpOpen, setIsShortcutsHelpOpen] = useAtom(isShortcutsHelpOpenAtom);
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  // Theme toggle handler
  const handleThemeToggle = useCallback(() => {
    setIsDarkMode(!isDarkMode);
  }, [isDarkMode, setIsDarkMode]);

  // View handlers
  const handleMarketView = useCallback(() => {
    setCurrentView("market");
  }, [setCurrentView]);

  const handleNewsView = useCallback(() => {
    setCurrentView("news");
  }, [setCurrentView]);

  const handleStockView = useCallback(() => {
    setCurrentView("stock");
  }, [setCurrentView]);

  const handlePortfolioView = useCallback(() => {
    setCurrentView("portfolio");
  }, [setCurrentView]);

  const handleTailView = useCallback(() => {
    setCurrentView("tail");
  }, [setCurrentView]);

  const handleBondView = useCallback(() => {
    setCurrentView("bonds");
  }, [setCurrentView]);

  // Other UI handlers
  const handleCancelClick = useCallback(() => {
    console.log("Cancel clicked");
    // Add your cancel logic here
  }, []);

  const handleNewClick = useCallback(() => {
    console.log("New clicked");
    // Add your new item logic here
  }, []);

  const handleBlancClick = useCallback(() => {
    console.log("Blanc clicked");
    // Add your blanc logic here
  }, []);

  const handleHelpClick = useCallback(() => {
    setIsShortcutsHelpOpen(true);
  }, [setIsShortcutsHelpOpen]);

  const handleCloseShortcutsHelp = useCallback(() => {
    setIsShortcutsHelpOpen(false);
  }, [setIsShortcutsHelpOpen]);

  return {
    // State
    isDarkMode,
    error,
    isShortcutsHelpOpen,
    currentView,

    // Setters
    setIsDarkMode,
    setError,
    setIsShortcutsHelpOpen,
    setCurrentView,

    // Handlers
    handleThemeToggle,
    handleMarketView,
    handleNewsView,
    handleStockView,
    handlePortfolioView,
    handleTailView,
    handleBondView,
    handleCancelClick,
    handleNewClick,
    handleBlancClick,
    handleHelpClick,
    handleCloseShortcutsHelp,
  };
}
