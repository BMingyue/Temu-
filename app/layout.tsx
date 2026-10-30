import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'织品工作台 · Temu 半托管'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
