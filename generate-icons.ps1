Add-Type -AssemblyName System.Drawing

function Create-AppIcon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded rectangle background or circle
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point 0, 0),
        (New-Object System.Drawing.Point $size, $size),
        [System.Drawing.Color]::FromArgb(255, 26, 115, 232),   # #1a73e8 Google Blue
        [System.Drawing.Color]::FromArgb(255, 11, 87, 208)     # Deep Google Blue
    )
    
    $radius = [int]($size * 0.22)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    
    # Path for rounded squircle
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    
    $g.FillPath($brush, $path)

    # Inner subtle glow/ring
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 255, 255, 255), [float]($size * 0.02))
    $g.DrawPath($pen, $path)

    # Draw stylized Shopping Bag + Location Pin / "ONM"
    # Draw Shopping Bag handle & body
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]($size * 0.05))
    $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    # Bag body
    $bagX = [int]($size * 0.28)
    $bagY = [int]($size * 0.38)
    $bagW = [int]($size * 0.44)
    $bagH = [int]($size * 0.42)
    $bagRadius = [int]($size * 0.06)

    $bagPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bd = $bagRadius * 2
    $bagPath.AddArc($bagX, $bagY, $bd, $bd, 180, 90)
    $bagPath.AddArc($bagX + $bagW - $bd, $bagY, $bd, $bd, 270, 90)
    $bagPath.AddArc($bagX + $bagW - $bd, $bagY + $bagH - $bd, $bd, $bd, 0, 90)
    $bagPath.AddArc($bagX, $bagY + $bagH - $bd, $bd, $bd, 90, 90)
    $bagPath.CloseFigure()
    $g.FillPath($whiteBrush, $bagPath)

    # Bag handle
    $handleX = [int]($size * 0.38)
    $handleY = [int]($size * 0.22)
    $handleW = [int]($size * 0.24)
    $handleH = [int]($size * 0.26)
    $g.DrawArc($whitePen, $handleX, $handleY, $handleW, $handleH, 180, 180)

    # Accent inside bag: Location Pin in Google Green/Amber or Blue
    $innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 128, 56)) # Google Green
    $innerPinY = [int]($size * 0.48)
    $pinSize = [int]($size * 0.16)
    $pinX = [int](($size - $pinSize) / 2)
    $g.FillEllipse($innerBrush, $pinX, $innerPinY, $pinSize, $pinSize)

    $innerDotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $dotSize = [int]($size * 0.06)
    $dotX = [int](($size - $dotSize) / 2)
    $dotY = [int]($innerPinY + ($pinSize - $dotSize) / 2)
    $g.FillEllipse($innerDotBrush, $dotX, $dotY, $dotSize, $dotSize)

    # Save PNG
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Output "Created: $outPath ($size x $size)"
}

$publicDir = "c:\Users\Ramcharan\Downloads\onm1\public"
if (!(Test-Path $publicDir)) {
    New-Item -ItemType Directory -Path $publicDir -Force | Out-Null
}

Create-AppIcon 192 "$publicDir\icon-192.png"
Create-AppIcon 512 "$publicDir\icon-512.png"
Create-AppIcon 512 "$publicDir\icon-maskable-512.png"
