export function ViewSkeleton() {
  return (
    <div className="flex items-center justify-center h-full bg-bb-bg">
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 rounded-full animate-spin border-bb-border border-t-transparent" />
        <span className="text-[10px] font-mono tracking-widest text-bb-text-dim">
          LOADING
        </span>
      </div>
    </div>
  );
}
