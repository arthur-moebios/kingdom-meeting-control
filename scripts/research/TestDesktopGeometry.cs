using System;
using System.Drawing;

class TestDesktopGeometry
{
    static void Equal(Rectangle expected, Rectangle actual)
    { if (expected != actual) throw new Exception("Expected " + expected + ", got " + actual); }
    static void Main()
    {
        Equal(new Rectangle(1420, 0, 500, 1080), DesktopGeometry.DockBounds(new Rectangle(0, 0, 1412, 1080), new Rectangle(0, 0, 1920, 1080), 500));
        Equal(new Rectangle(92, 0, 500, 800), DesktopGeometry.DockBounds(new Rectangle(600, 0, 1200, 800), new Rectangle(0, 0, 1920, 1080), 500));
        Equal(new Rectangle(-508, 0, 500, 1080), DesktopGeometry.DockBounds(new Rectangle(-1920, 0, 1404, 1080), new Rectangle(-1920, 0, 1920, 1080), 500));
        Equal(new Rectangle(0, 0, 908, 500), DesktopGeometry.HostCrop(new Rectangle(0, 5, 908, 818), new Rectangle(-10, 5, 928, 500)));
        Equal(Rectangle.Empty, DesktopGeometry.HostCrop(new Rectangle(0, 0, 908, 818), new Rectangle(2000, 2000, 800, 500)));
        Equal(new Rectangle(7, 182, 894, 501), DesktopGeometry.HostCrop(new Rectangle(3000, 5, 908, 818), new Rectangle(3007, 187, 894, 501)));
        Console.WriteLine("6 desktop geometry checks passed; no windows were changed.");
    }
}
