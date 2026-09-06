# VoxFlow - helper d'injection clavier
#
# Ce script est lance une seule fois au demarrage de l'application et reste en
# vie : il lit des commandes sur son entree standard et les traduit en appels
# Win32 SendInput. Le cout de compilation d'Add-Type (~1 s) est donc paye une
# fois, et chaque injection devient instantanee.
#
# Protocole (une commande par ligne) :  <id>|<COMMANDE>|<charge utile>
#   <id>|PING|                -> <id>|OK|PONG
#   <id>|PASTE|               -> envoie Ctrl+V
#   <id>|TYPE|<base64 utf8>   -> tape le texte caractere par caractere (Unicode)
#   <id>|KEY|<code virtuel>   -> appuie puis relache une touche
#   <id>|QUIT|                -> termine le processus
# Reponses : <id>|OK|<info>  ou  <id>|ERR|<message>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class VoxInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg; public ushort wParamL; public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);

    static INPUT MakeKey(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        i.u.ki.time = 0;
        i.u.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    static void Send(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            throw new Exception("SendInput a rejete l'entree (code " + Marshal.GetLastWin32Error() + ")");
        }
    }

    // Tape une chaine en Unicode : independant de la disposition du clavier,
    // donc les accents et les emoji passent sans remapping.
    public static void TypeText(string text, int delayMs)
    {
        foreach (char c in text)
        {
            if (c == '\n')
            {
                PressKey(0x0D); // Entree
                continue;
            }
            if (c == '\r') continue;

            INPUT[] pair = new INPUT[2];
            pair[0] = MakeKey(0, (ushort)c, KEYEVENTF_UNICODE);
            pair[1] = MakeKey(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            Send(pair);
            if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
        }
    }

    public static void PressKey(ushort vk)
    {
        INPUT[] pair = new INPUT[2];
        pair[0] = MakeKey(vk, 0, 0);
        pair[1] = MakeKey(vk, 0, KEYEVENTF_KEYUP);
        Send(pair);
    }

    // Ctrl+V. On relache d'abord les modificateurs encore tenus par l'utilisateur
    // (le raccourci de dictee est justement Ctrl+Maj) sinon le collage devient
    // Ctrl+Maj+V, qui colle « sans mise en forme » ou ne fait rien selon l'app.
    public static void Paste()
    {
        const ushort VK_CONTROL = 0x11;
        const ushort VK_SHIFT = 0x10;
        const ushort VK_MENU = 0x12;
        const ushort VK_LWIN = 0x5B;
        const ushort VK_RWIN = 0x5C;
        const ushort VK_V = 0x56;

        ushort[] toRelease = { VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, VK_CONTROL };
        INPUT[] release = new INPUT[toRelease.Length];
        for (int i = 0; i < toRelease.Length; i++)
        {
            release[i] = MakeKey(toRelease[i], 0, KEYEVENTF_KEYUP);
        }
        Send(release);
        System.Threading.Thread.Sleep(15);

        INPUT[] paste = new INPUT[4];
        paste[0] = MakeKey(VK_CONTROL, 0, 0);
        paste[1] = MakeKey(VK_V, 0, 0);
        paste[2] = MakeKey(VK_V, 0, KEYEVENTF_KEYUP);
        paste[3] = MakeKey(VK_CONTROL, 0, KEYEVENTF_KEYUP);
        Send(paste);
    }
}
"@

Write-Output "0|READY|"
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $parts = $line.Split('|', 3)
    $id = $parts[0]
    $cmd = if ($parts.Length -gt 1) { $parts[1].ToUpperInvariant() } else { '' }
    $payload = if ($parts.Length -gt 2) { $parts[2] } else { '' }

    try {
        switch ($cmd) {
            'PING' {
                Write-Output "$id|OK|PONG"
            }
            'PASTE' {
                [VoxInput]::Paste()
                Write-Output "$id|OK|"
            }
            'TYPE' {
                $split = $payload.Split(':', 2)
                $delay = 0
                $b64 = $payload
                if ($split.Length -eq 2) {
                    $delay = [int]$split[0]
                    $b64 = $split[1]
                }
                $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
                [VoxInput]::TypeText($text, $delay)
                Write-Output "$id|OK|$($text.Length)"
            }
            'KEY' {
                [VoxInput]::PressKey([uint16]$payload)
                Write-Output "$id|OK|"
            }
            'QUIT' {
                Write-Output "$id|OK|BYE"
                [Console]::Out.Flush()
                exit 0
            }
            default {
                Write-Output "$id|ERR|Commande inconnue : $cmd"
            }
        }
    } catch {
        $msg = $_.Exception.Message -replace "`r?`n", ' '
        Write-Output "$id|ERR|$msg"
    }
    [Console]::Out.Flush()
}
