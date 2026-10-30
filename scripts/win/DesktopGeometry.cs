using System;
using System.Drawing;

internal static class DesktopGeometry
{
    internal static Rectangle DockBounds(Rectangle jw, Rectangle work, int panelWidth)
    {
        int x = jw.Right + 8;
        if (x + panelWidth > work.Right) x = jw.Left - panelWidth - 8;
        x = Math.Max(work.Left, Math.Min(x, work.Right - panelWidth));
        int y = Math.Max(work.Top, jw.Top);
        int height = Math.Min(jw.Bottom, work.Bottom) - y;
        return height > 250 ? new Rectangle(x, y, panelWidth, height) : Rectangle.Empty;
    }
    internal static Rectangle HostCrop(Rectangle sourceWindow, Rectangle host)
    {
        var crop = Rectangle.Intersect(sourceWindow, host);
        if (crop.Width < 80 || crop.Height < 60) return Rectangle.Empty;
        crop.Offset(-sourceWindow.Left, -sourceWindow.Top);
        return crop;
    }
}
