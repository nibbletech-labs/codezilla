import type { LucideIcon } from "lucide-react";
import {
  // Development
  Code, CodeXml, Terminal, Bug, GitBranch, GitCommitHorizontal,
  GitFork, GitMerge, GitPullRequest, GitCompare,
  Database, DatabaseZap, Server, ServerCog,
  Globe, Cpu, Braces, Brackets, FileCode, FileJson,
  FileTerminal, MonitorSmartphone, Wifi, HardDrive,
  Binary, Blocks, Box, Container, Package, Plug,
  PlugZap, Router, Network, CircuitBoard, Webhook,
  Regex, Variable, Command, Codesandbox, Github,
  Laptop, Smartphone, Tablet, Keyboard,
  Folder, FolderCode, FolderGit2, FolderOpen,
  CloudUpload, CloudDownload, Satellite, Cable,
  // Business
  Briefcase, Building, Building2, BarChart, BarChart3,
  TrendingUp, TrendingDown, DollarSign, ShoppingCart, ShoppingBag,
  Users, UserCircle, CreditCard, PieChart, Receipt,
  Landmark, Store, Wallet, BadgeDollarSign, Banknote,
  Calculator, CalendarDays, ClipboardList, FileSpreadsheet,
  Inbox, Mail, MailOpen, Send, Phone, PhoneCall,
  Megaphone, Presentation, LineChart, Target,
  Handshake, Scale, Gavel, Newspaper,
  // Creative
  Palette, Pen, PenTool, Pencil, Camera, Music, Music2,
  Film, Brush, PaintBucket, Figma, Image, Images,
  Scissors, Aperture, Mic, Video, Headphones,
  Clapperboard, Drama, Podcast, Radio, Speaker,
  Type, BookOpen, BookMarked, NotebookPen, Feather,
  Eraser, Highlighter, Paintbrush, Layers,
  Blend, Pipette, Crop, ScanLine,
  // Objects
  Rocket, Zap, Star, Heart, Bookmark, Flag,
  Trophy, Crown, Gem, Flame, Gift, Anchor,
  Compass, Umbrella, Bell, Clock, Hourglass, Timer,
  Lamp, Flashlight, Battery, BatteryCharging,
  Wrench, Hammer, Axe, Shovel, Drill,
  Magnet, Paperclip, Pin, MapPin, Map,
  Ticket, Tag, Tags, Key, Lock, Unlock,
  Glasses, Watch, Backpack, Luggage,
  Home, Castle, Tent, Warehouse, Church,
  // Science & Nature
  Leaf, Sun, Moon, Cloud, Mountain, Flower, Flower2,
  TreePine, Trees, Snowflake, Waves, Sprout, CloudRain,
  CloudLightning, CloudSun, Rainbow, Droplets, Wind,
  Thermometer, ThermometerSun,
  Atom, FlaskConical, FlaskRound, Microscope, Dna,
  TestTube, TestTubes, Biohazard, Radiation,
  Bird, Cat, Dog, Fish, Rabbit, Squirrel,
  Turtle, Shell,
  // Symbols & Shapes
  Hash, AtSign, CircleDot, Shield, ShieldCheck,
  Lightbulb, Eye, EyeOff, Fingerprint, Infinity,
  Crosshair, Activity, Hexagon, Pentagon, Triangle,
  Diamond, Circle, Square, Octagon,
  AlertTriangle, AlertCircle, Info, HelpCircle,
  CheckCircle, XCircle, Plus, Minus,
  ArrowRight, ArrowUp, ArrowDown, RefreshCw, RotateCw,
  Sparkles, Sparkle, Wand2, Swords,
  Power, ToggleLeft, Settings, SlidersHorizontal,
  Search, Filter, ListFilter, Gauge,
  // Food & Travel
  Coffee, CupSoda, Wine, Beer, UtensilsCrossed,
  Pizza, Sandwich, Cake, IceCream, Cherry, Apple,
  Grape, Banana, Citrus, Salad, Soup, Popcorn,
  Plane, Car, Bus, Train, Ship, Bike,
  Fuel, ParkingCircle, Navigation,
  // People & Social
  User, UserPlus, UserCheck,
  Baby, PersonStanding, Accessibility,
  MessageCircle, MessageSquare, MessagesSquare,
  ThumbsUp, ThumbsDown,
  Share, Share2, ExternalLink, Link, Link2,
  Globe2, Languages, Smile, Frown, Laugh,
  HeartHandshake,
  // Gaming & Sports
  Gamepad, Gamepad2, Joystick, Dice1, Dice5,
  Puzzle, Ghost, Sword,
  Dumbbell, Medal,
  Footprints,
} from "lucide-react";
import type { Project } from "../store/types";

export const LUCIDE_MAP: Record<string, LucideIcon> = {
  // Development
  Code, CodeXml, Terminal, Bug, GitBranch, GitCommitHorizontal,
  GitFork, GitMerge, GitPullRequest, GitCompare,
  Database, DatabaseZap, Server, ServerCog,
  Globe, Cpu, Braces, Brackets, FileCode, FileJson,
  FileTerminal, MonitorSmartphone, Wifi, HardDrive,
  Binary, Blocks, Box, Container, Package, Plug,
  PlugZap, Router, Network, CircuitBoard, Webhook,
  Regex, Variable, Command, Codesandbox, Github,
  Laptop, Smartphone, Tablet, Keyboard,
  Folder, FolderCode, FolderGit2, FolderOpen,
  CloudUpload, CloudDownload, Satellite, Cable,
  // Business
  Briefcase, Building, Building2, BarChart, BarChart3,
  TrendingUp, TrendingDown, DollarSign, ShoppingCart, ShoppingBag,
  Users, UserCircle, CreditCard, PieChart, Receipt,
  Landmark, Store, Wallet, BadgeDollarSign, Banknote,
  Calculator, CalendarDays, ClipboardList, FileSpreadsheet,
  Inbox, Mail, MailOpen, Send, Phone, PhoneCall,
  Megaphone, Presentation, LineChart, Target,
  Handshake, Scale, Gavel, Newspaper,
  // Creative
  Palette, Pen, PenTool, Pencil, Camera, Music, Music2,
  Film, Brush, PaintBucket, Figma, Image, Images,
  Scissors, Aperture, Mic, Video, Headphones,
  Clapperboard, Drama, Podcast, Radio, Speaker,
  Type, BookOpen, BookMarked, NotebookPen, Feather,
  Eraser, Highlighter, Paintbrush, Layers,
  Blend, Pipette, Crop, ScanLine,
  // Objects
  Rocket, Zap, Star, Heart, Bookmark, Flag,
  Trophy, Crown, Gem, Flame, Gift, Anchor,
  Compass, Umbrella, Bell, Clock, Hourglass, Timer,
  Lamp, Flashlight, Battery, BatteryCharging,
  Wrench, Hammer, Axe, Shovel, Drill,
  Magnet, Paperclip, Pin, MapPin, Map,
  Ticket, Tag, Tags, Key, Lock, Unlock,
  Glasses, Watch, Backpack, Luggage,
  Home, Castle, Tent, Warehouse, Church,
  // Science & Nature
  Leaf, Sun, Moon, Cloud, Mountain, Flower, Flower2,
  TreePine, Trees, Snowflake, Waves, Sprout, CloudRain,
  CloudLightning, CloudSun, Rainbow, Droplets, Wind,
  Thermometer, ThermometerSun,
  Atom, FlaskConical, FlaskRound, Microscope, Dna,
  TestTube, TestTubes, Biohazard, Radiation,
  Bird, Cat, Dog, Fish, Rabbit, Squirrel,
  Turtle, Shell,
  // Symbols & Shapes
  Hash, AtSign, CircleDot, Shield, ShieldCheck,
  Lightbulb, Eye, EyeOff, Fingerprint, Infinity,
  Crosshair, Activity, Hexagon, Pentagon, Triangle,
  Diamond, Circle, Square, Octagon,
  AlertTriangle, AlertCircle, Info, HelpCircle,
  CheckCircle, XCircle, Plus, Minus,
  ArrowRight, ArrowUp, ArrowDown, RefreshCw, RotateCw,
  Sparkles, Sparkle, Wand2, Swords,
  Power, ToggleLeft, Settings, SlidersHorizontal,
  Search, Filter, ListFilter, Gauge,
  // Food & Travel
  Coffee, CupSoda, Wine, Beer, UtensilsCrossed,
  Pizza, Sandwich, Cake, IceCream, Cherry, Apple,
  Grape, Banana, Citrus, Salad, Soup, Popcorn,
  Plane, Car, Bus, Train, Ship, Bike,
  Fuel, ParkingCircle, Navigation,
  // People & Social
  User, UserPlus, UserCheck,
  Baby, PersonStanding, Accessibility,
  MessageCircle, MessageSquare, MessagesSquare,
  ThumbsUp, ThumbsDown,
  Share, Share2, ExternalLink, Link, Link2,
  Globe2, Languages, Smile, Frown, Laugh,
  HeartHandshake,
  // Gaming & Sports
  Gamepad, Gamepad2, Joystick, Dice1, Dice5,
  Puzzle, Ghost, Sword,
  Dumbbell, Medal,
  Footprints,
};

const DEFAULT_COLOR = "var(--text-secondary)";

interface ProjectIconProps {
  project: Project;
  size: number;
  onClick?: (e: React.MouseEvent) => void;
}

export default function ProjectIcon({ project, size, onClick }: ProjectIconProps) {
  const icon = project.icon;

  const wrapStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginRight: 2,
    cursor: onClick ? "pointer" : undefined,
    borderRadius: 4,
  };

  if (!icon) {
    return (
      <span style={wrapStyle} onClick={onClick}>
        <Folder size={size} color={DEFAULT_COLOR} strokeWidth={2} />
      </span>
    );
  }

  if (icon.type === "emoji") {
    // Emojis render visually larger than SVG icons at the same font-size,
    // so scale down and fix the container to match Lucide icon dimensions.
    const emojiScale = 0.88;
    return (
      <span
        style={{
          ...wrapStyle,
          width: size,
          height: size,
          fontSize: size * emojiScale,
          lineHeight: 1,
          overflow: "hidden",
        }}
        onClick={onClick}
      >
        {icon.value}
      </span>
    );
  }

  // Lucide icon
  const IconComponent = LUCIDE_MAP[icon.name];
  if (!IconComponent) {
    return (
      <span style={wrapStyle} onClick={onClick}>
        <Folder size={size} color={DEFAULT_COLOR} strokeWidth={2} />
      </span>
    );
  }

  return (
    <span style={wrapStyle} onClick={onClick}>
      <IconComponent size={size} color={icon.color} strokeWidth={2} />
    </span>
  );
}
