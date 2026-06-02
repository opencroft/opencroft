import { cn } from "@/lib/utils";
import { Flex } from "@/components/ui/layout/flex";
import { ScrollArea } from "@/components/ui/layout/scroll-area";

export function ScrollPage({ className, children, ...props }: { className?: string, children: React.ReactNode }) {
  return (
    <Flex className={cn("relative flex-1 min-h-0 overflow-hidden", className)} {...props}>
      {children}
    </Flex>
  )
}

export function ScrollHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Flex row withSpacing
      className={cn("border-b", className)}
      {...props}
    />
  )
}

export function ScrollContent({ centered, children, className, ...props }: { centered?: boolean, children: React.ReactNode, className?: string }) {
  return (
    <ScrollArea
      className="flex-1"
      innerClassName={cn(centered && 'items-center', className)}
      {...props}
    >
      {children}
    </ScrollArea>
  )
}

export function ScrollFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Flex row withSpacing
      className={cn("border-t", className)}
      {...props}
    />
  )
}
