import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 标准 class 合并工具（组件库约定的唯一的 className 归一入口）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
